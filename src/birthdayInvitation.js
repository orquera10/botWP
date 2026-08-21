import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = path.resolve(MODULE_DIR, '..', 'assets', 'birthday');

export const BIRTHDAY_INVITATION_TEMPLATE = path.join(ASSETS_DIR, 'invitacion_cumple_01.png');
export const BIRTHDAY_RULES_IMAGE = path.join(ASSETS_DIR, 'reglamento_cancha.png');
export const BIRTHDAY_CONTACT_URL = 'https://wa.me/5493886002759';

function escapeXml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function cleanText(value, maxLength) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function invitationNameLines(value) {
  const name = cleanText(value, 48).toLocaleUpperCase('es-AR');
  if (name.length <= 22) return [name];

  const words = name.split(' ');
  let first = '';
  let second = '';
  for (const word of words) {
    if (!first) {
      first = word;
    } else if (!second && `${first} ${word}`.trim().length <= 22) {
      first = `${first} ${word}`.trim();
    } else {
      second = `${second} ${word}`.trim();
    }
  }

  return second ? [first, second] : [name];
}

function nameFontSize(lines) {
  const longest = Math.max(...lines.map(line => line.length), 1);
  return Math.max(34, Math.min(lines.length === 1 ? 72 : 54, Math.floor(940 / longest)));
}

export function formatInvitationPhone(value) {
  let digits = String(value || '').replace(/\D/g, '');
  if (digits.startsWith('549')) digits = digits.slice(3);
  else if (digits.startsWith('54')) digits = digits.slice(2);
  digits = digits.replace(/^0+/, '');

  if (digits.length === 10) {
    return `${digits.slice(0, 4)} ${digits.slice(4)}`;
  }

  return cleanText(value, 24);
}

export async function createBirthdayInvitation({ name, date, startTime, endTime, phone }) {
  const nameLines = invitationNameLines(name);
  const fontSize = nameFontSize(nameLines);
  const nameStartY = nameLines.length === 1 ? 570 : 535;
  const lineHeight = Math.round(fontSize * 1.12);
  const nameSvg = nameLines
    .map((line, index) => `<text x="527" y="${nameStartY + (index * lineHeight)}" text-anchor="middle">${escapeXml(line)}</text>`)
    .join('');
  const dateText = cleanText(date, 24);
  const timeText = cleanText(endTime ? `${startTime} a ${endTime}` : startTime, 28);
  const phoneText = formatInvitationPhone(phone);

  const overlay = Buffer.from(`
    <svg width="1054" height="1492" xmlns="http://www.w3.org/2000/svg">
      <style>
        .name { font-family: Arial, Helvetica, sans-serif; font-size: ${fontSize}px; font-weight: 900; fill: #111; }
        .field { font-family: Arial, Helvetica, sans-serif; font-size: 40px; font-weight: 800; fill: #111; }
      </style>
      <g class="name">${nameSvg}</g>
      <text class="field" x="395" y="824" text-anchor="middle">${escapeXml(dateText)}</text>
      <text class="field" x="395" y="989" text-anchor="middle">${escapeXml(timeText)}</text>
      <text class="field" x="395" y="1154" text-anchor="middle">${escapeXml(phoneText)}</text>
    </svg>
  `);

  return sharp(BIRTHDAY_INVITATION_TEMPLATE)
    .composite([{ input: overlay, top: 0, left: 0 }])
    .png()
    .toBuffer();
}
