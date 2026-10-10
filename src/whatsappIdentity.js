// Only protocol metadata may resolve an identity; never use the message text,
// display name or the numeric part of a LID as a phone number.
export function senderPhoneJid(message) {
  if (message.key?.remoteJid?.endsWith('@g.us')) return null;
  for (const value of [message.key?.remoteJid, message.key?.remoteJidAlt, message.senderPn, message.key?.senderPn]) {
    if (typeof value !== 'string' || !value.endsWith('@s.whatsapp.net')) continue;
    const phone = value.split('@')[0].split(':')[0];
    if (/^\d{9,15}$/.test(phone)) return `${phone}@s.whatsapp.net`;
  }
  return null;
}
