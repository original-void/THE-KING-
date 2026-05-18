import makeWASocket, { useMultiFileAuthState, DisconnectReason, Browsers, delay } from 'baileys';
import pino from 'pino';
import fs from 'fs';
import http from 'http';

const PHONE_NUMBER = process.env.PHONE_NUMBER;
const GROUP_NAME = 'THE KING';
const WARN_FILE = './warnings.json';
const CONFIG_FILE = './config.json';

// Keep-alive server for Render
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200);
  res.end('THE KING bot is alive');
}).listen(PORT, () => console.log(`Keep-alive server running on port ${PORT}`));

// Load warnings
let warnings = {};
if (fs.existsSync(WARN_FILE)) {
  warnings = JSON.parse(fs.readFileSync(WARN_FILE, 'utf-8'));
}

function saveWarnings() {
  fs.writeFileSync(WARN_FILE, JSON.stringify(warnings, null, 2));
}

// Load config
let config = { antiLove: true };
if (fs.existsSync(CONFIG_FILE)) {
  config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
}

function saveConfig() {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('./group-auth');

  const sock = makeWASocket({
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    auth: state,
    browser: Browsers.macOS('Desktop')
  });

  if (!sock.authState.creds.registered) {
    if (!PHONE_NUMBER) {
      console.log('Set PHONE_NUMBER env var');
      process.exit(1);
    }
    await delay(2000);
    const code = await sock.requestPairingCode(PHONE_NUMBER);
    console.log('PAIRING CODE:', code);
  }

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode!== DisconnectReason.loggedOut;
      if (shouldReconnect) startBot();
    }
    if (connection === 'open') {
      console.log('Group bot connected to WhatsApp!');
    }
  });

  sock.ev.on('creds.update', saveCreds);

  // Welcome new members
  sock.ev.on('group-participants.update', async (update) => {
    const { id, participants, action } = update;

    if (action === 'add') {
      for (const user of participants) {
        const name = user.split('@')[0];
        const loveRule = config.antiLove? 'No love talk allowed' : 'Love talk is allowed for now';
        await sock.sendMessage(id, {
          text: `👑 Welcome to ${GROUP_NAME}, @${name}!\n\nRead the group description and follow the rules. ${loveRule} 💪`,
          mentions:
        });
      }
    }

    if (action === 'remove') {
      for (const user of participants) {
        const name = user.split('@')[0];
        await sock.sendMessage(id, {
          text: `@${name} left the empire 😔`,
          mentions:
        });
      }
    }
  });

  // Command handler - rest of your code stays the same
  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const text = msg.message.conversation || msg.message.extendedTextMessage?.text;
    const sender = msg.key.remoteJid;
    const senderId = msg.key.participant || msg.key.remoteJid;

    if (!sender.endsWith('@g.us')) return;

    const groupMetadata = await sock.groupMetadata(sender);
    const senderData = groupMetadata.participants.find(p => p.id === senderId);
    const isAdmin = senderData?.admin;

    const command = text?.toLowerCase().trim();
    const mentioned = msg.message.extendedTextMessage?.contextInfo?.mentionedJid || [];

    // ANTI-LOVE FILTER
    if (config.antiLove) {
      const loveWords = [
        'love', 'lover', 'lovers', 'crush', 'dating', 'date me', 'girlfriend', 'boyfriend',
        'gf', 'bf', 'marry me', 'i love you', 'ily', 'romance', 'relationship', 'valentine',
        'upendo', 'kupenda', 'penzi', 'mapenzi', 'mpenzi', 'wapenzi', 'napenda', 'nakupenda',
        'nakupenda sana', 'mapenzi yangu', 'mchumba', 'kuchumbiana', 'uchumba'
      ];

      const textLower = text?.toLowerCase() || '';
      const containsLove = loveWords.some(word => textLower.includes(word));

      if (containsLove &&!isAdmin) {
        await sock.sendMessage(sender, { delete: msg.key });

        const userId = senderId;
        if (!warnings[userId]) warnings[userId] = [];
        warnings[userId].push({
          reason: 'Talking about love - not allowed',
          time: new Date().toLocaleString(),
          warner: 'Auto-Mod'
        });
        saveWarnings();

        const warnCount = warnings[userId].length;

        await sock.sendMessage(sender, {
          text: `@${userId.split('@')[0]} ⚠️ Love talk is banned in ${GROUP_NAME}.\n` +
                `Warning: ${warnCount}/3\nKeep it clean or you'll be kicked.`,
          mentions: [userId]
        });

        if (warnCount >= 3) {
          await sock.groupParticipantsUpdate(sender, [userId], 'remove');
          await sock.sendMessage(sender, { text: `@${userId.split('@')[0]} kicked for 3 warnings`, mentions: [userId] });
          delete warnings[userId];
          saveWarnings();
        }
        return;
      }
    }

    //.help
    if (command === '.help') {
      await sock.sendMessage(sender, {
        text: `*THE KING Bot Commands* 👑\n\n` +
              `*Admin only:*\n` +
              `.tagall - Tag everyone\n` +
              `.kick @user - Remove member\n` +
              `.promote @user - Make admin\n` +
              `.demote @user - Remove admin\n` +
              `.mute @user 10m - Mute user for 10 min\n` +
              `.unmute @user - Unmute user\n` +
              `.warn @user reason - Warn user\n` +
              `.info @user - Show user info\n` +
              `.allowlove on/off - Toggle love filter\n` +
              `.allowlove off 1h - Turn off for 1h, auto re-enable\n` +
              `*Everyone:*\n` +
              `.help - Show this menu\n` +
              `.me - Show your warnings\n` +
              `*Status:* Love filter is ${config.antiLove? 'ON' : 'OFF'}`
      });
    }

    //.allowlove on/off [time]
    if (command?.startsWith('.allowlove') && isAdmin) {
      const args = text.split(' ');
      const state = args[1];
      const timeArg = args[2];

      if (state === 'off') {
        config.antiLove = false;
        saveConfig();
        await sock.sendMessage(sender, { text: '💘 Love filter OFF. Love talk is now allowed.' });

        if (timeArg) {
          const timeMatch = timeArg.match(/^(\d+)(m|h)$/);
          if (timeMatch) {
            const value = parseInt(timeMatch[1]);
            const unit = timeMatch[2];
            const ms = unit === 'h'? value * 3600000 : value * 60000;

            setTimeout(async () => {
              config.antiLove = true;
              saveConfig();
              await sock.sendMessage(sender, { text: '⏰ Time up! Love filter is ON again.' });
            }, ms);

            await sock.sendMessage(sender, { text: `⏳ Will auto re-enable in ${timeArg}` });
          } else {
            await sock.sendMessage(sender, { text: 'Invalid time format. Use 30m, 1h, 2h etc.' });
          }
        }
      } else if (state === 'on') {
        config.antiLove = true;
        saveConfig();
        await sock.sendMessage(sender, { text: '🚫 Love filter ON. Love talk is banned again.' });
      } else {
        await sock.sendMessage(sender, { text: 'Usage:\n.allowlove on\n.allowlove off\n.allowlove off 1h' });
      }
    }

    //.tagall
    if (command === '.tagall' && isAdmin) {
      const members = groupMetadata.participants.map(p => p.id);
      const mentions = members.map(m => `@${m.split('@')[0]}`).join(' ');
      await sock.sendMessage(sender, {
        text: `📢 ATTENTION ${GROUP_NAME}!\n\n${mentions}`,
        mentions: members
      });
    }

    //.kick @user
    if (command?.startsWith('.kick') && isAdmin) {
      if (!mentioned.length) return sock.sendMessage(sender, { text: 'Tag the user to kick:.kick @user' });
      await sock.groupParticipantsUpdate(sender, mentioned, 'remove');
      await sock.sendMessage(sender, { text: `Kicked @${mentioned[0].split('@')[0]}`, mentions: mentioned });
    }

    //.promote @user
    if (command?.startsWith('.promote') && isAdmin) {
      if (!mentioned.length) return sock.sendMessage(sender, { text: 'Tag the user to promote:.promote @user' });
      await sock.groupParticipantsUpdate(sender, mentioned, 'promote');
      await sock.sendMessage(sender, { text: `@${mentioned[0].split('@')[0]} is now admin 👑`, mentions: mentioned });
    }

    //.demote @user
    if (command?.startsWith('.demote') && isAdmin) {
      if (!mentioned.length) return sock.sendMessage(sender, { text: 'Tag the user to demote:.demote @user' });
      await sock.groupParticipantsUpdate(sender, mentioned, 'demote');
      await sock.sendMessage(sender, { text: `@${mentioned[0].split('@')[0]} is no longer admin`, mentions: mentioned });
    }

    //.mute @user 10m
    if (command?.startsWith('.mute') && isAdmin) {
      if (!mentioned.length) return sock.sendMessage(sender, { text: 'Tag the user to mute:.mute @user 10m' });
      const timeArg = text.split(' ')[2] || '10m';
      const minutes = parseInt(timeArg.replace('m', ''));
      if (isNaN(minutes)) return sock.sendMessage(sender, { text: 'Use format:.mute @user 10m' });

      await sock.groupParticipantsUpdate(sender, mentioned, 'demote');
      await sock.sendMessage(sender, { text: `@${mentioned[0].split('@')[0]} muted for ${minutes} min`, mentions: mentioned });

      setTimeout(async () => {
        await sock.sendMessage(sender, { text: `@${mentioned[0].split('@')[0]} unmuted`, mentions: mentioned });
      }, minutes * 60000);
    }

    //.unmute @user
    if (command?.startsWith('.unmute') && isAdmin) {
      if (!mentioned.length) return sock.sendMessage(sender, { text: 'Tag the user to unmute:.unmute @user' });
      await sock.sendMessage(sender, { text: `@${mentioned[0].split('@')[0]} unmuted`, mentions: mentioned });
    }

    //.warn @user reason
    if (command?.startsWith('.warn') && isAdmin) {
      if (!mentioned.length) return sock.sendMessage(sender, { text: 'Tag the user to warn:.warn @user reason' });
      const reason = text.split(' ').slice(2).join(' ') || 'No reason given';
      const userId = mentioned[0];

      if (!warnings[userId]) warnings[userId] = [];
      warnings[userId].push({ reason, time: new Date().toLocaleString(), warner: senderId });
      saveWarnings();

      const warnCount = warnings[userId].length;
      await sock.sendMessage(sender, {
        text: `@${userId.split('@')[0]} warned. Reason: ${reason}\nWarnings: ${warnCount}/3`,
        mentions: mentioned
      });

      if (warnCount >= 3) {
        await sock.groupParticipantsUpdate(sender, [userId], 'remove');
        await sock.sendMessage(sender, { text: `@${userId.split('@')[0]} kicked for 3 warnings`, mentions: [userId] });
        delete warnings[userId];
        saveWarnings();
      }
    }

    //.info @user
    if (command?.startsWith('.info')) {
      const targetUser = mentioned[0] || senderId;
      const userData = groupMetadata.participants.find(p => p.id === targetUser);
      const userWarns = warnings[targetUser]?.length || 0;

      await sock.sendMessage(sender, {
        text: `*User Info*\n` +
              `Name: @${targetUser.split('@')[0]}\n` +
              `Role: ${userData?.admin? 'Admin' : 'Member'}\n` +
              `Warnings: ${userWarns}/3\n` +
              `Joined: ${userData?.joinTime? new Date(userData.joinTime * 1000).toLocaleDateString() : 'Unknown'}`,
        mentions: [targetUser]
      });
    }

    //.me
    if (command === '.me') {
      const userWarns = warnings[senderId]?.length || 0;
      let warnList = '';
      if (warnings[senderId]) {
        warnings[senderId].forEach((w, i) => {
          warnList += `\n${i+1}. ${w.reason} - ${w.time}`;
        });
      }
      await sock.sendMessage(sender, {
        text: `*Your Info*\nWarnings: ${userWarns}/3${warnList}`,
        mentions: [senderId]
      });
    }
  });

  return sock;
}

startBot();
