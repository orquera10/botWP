import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import opentype from 'opentype.js';
import sharp from 'sharp';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = path.resolve(MODULE_DIR, '..', 'assets', 'birthday');
const require = createRequire(import.meta.url);
const ANTON_DIR = path.dirname(require.resolve('@fontsource/anton/package.json'));
const BARLOW_CONDENSED_DIR = path.dirname(require.resolve('@fontsource/barlow-condensed/package.json'));
const nameFont = opentype.loadSync(
  path.join(ANTON_DIR, 'files', 'anton-latin-400-normal.woff')
);
const detailsFont = opentype.loadSync(
  path.join(BARLOW_CONDENSED_DIR, 'files', 'barlow-condensed-latin-600-normal.woff')
);

export const BIRTHDAY_INVITATION_TEMPLATE = path.join(ASSETS_DIR, 'invitacion_cumple_01.png');
export const BIRTHDAY_RULES_IMAGE = path.join(ASSETS_DIR, 'reglamento_cancha.png');
export const BIRTHDAY_CONTACT_URL = 'https://wa.me/5493886002759';

const COMMON_FIRST_NAMES = new Set(`
  agustin alan alejandra alejandra alejandro alex alexis alicia alma ambar amparo ana andrea
  andres angela antonella antonio april araceli ariel augusto ayelen azucena bautista belen
  benicio benjamin bianca brenda brisa bruno camila candela carla carlos carolina catalina
  cecilia celeste cesar chiara clara claudio constanza cristian cristina damian daniela daniel
  dante dario debora delfina diego dolores eduardo elena elias elisa emilia emiliano emma
  enzo esteban eugenia eva facundo fabian federico felipe fernanda fernando florencia francisco
  franco gabriel gabriela gael gaspar gerardo gisela giuliana gloria gonzalo graciela guadalupe
  gustavo hector ignacio ines isabel ivan jazmin jeremias joaquin jorge jose josefina juan
  juana julian juliana karen karina lara lautaro leandro leonel lola lorena lucas lucia luciana
  luciano luis luz magali maia maite malena manuel marcelo marcos margarita maria mariano
  marina mario martina martin mateo matias maxima maximiliano melina mercedes mia micaela
  milagros mirta monica nahuel natalia nicolas noa noelia olivia oscar pablo paola patricia
  paulina pedro pilar ramiro raul renata ricardo roberto rocio rodolfo romina rosa rosario
  sabrina samuel santiago sara sebastian sergio silvana silvia simon sofia soledad susana
  tamara teo teresa thiago tiago valentina valeria valentino vicente victoria zoe
`.trim().split(/\s+/));

function cleanText(value, maxLength) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function normalizeNameToken(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function formatFirstName(value) {
  return String(value || '')
    .toLocaleLowerCase('es-AR')
    .split('-')
    .map((part) => part ? `${part[0].toLocaleUpperCase('es-AR')}${part.slice(1)}` : '')
    .join('-');
}

export function invitationFirstName(value) {
  const words = cleanText(value, 80).match(/[\p{L}]+(?:[-'][\p{L}]+)*/gu) || [];
  if (words.length === 1) return formatFirstName(words[0]);
  if (words.length < 2) return '';

  const recognized = words.find((word) => COMMON_FIRST_NAMES.has(normalizeNameToken(word)));
  return recognized ? formatFirstName(recognized) : '';
}

export function invitationNameOptions(value) {
  const words = cleanText(value, 80).match(/[\p{L}]+(?:[-'][\p{L}]+)*/gu) || [];
  const recognized = words
    .filter((word) => COMMON_FIRST_NAMES.has(normalizeNameToken(word)))
    .map(formatFirstName);

  if (recognized.length < 2) return [];

  const firstName = recognized[0];
  const compoundName = recognized.join(' ');
  return firstName === compoundName ? [firstName] : [firstName, compoundName];
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
  const maximum = lines.length === 1 ? 112 : 76;
  const widest = Math.max(...lines.map(line => nameFont.getAdvanceWidth(line, maximum)), 1);
  return Math.max(40, Math.floor(maximum * Math.min(1, 700 / widest)));
}

function centeredTextPath(font, text, centerX, baselineY, fontSize) {
  const width = font.getAdvanceWidth(text, fontSize);
  const glyphPath = font.getPath(text, centerX - (width / 2), baselineY, fontSize);
  return `<path d="${glyphPath.toPathData(2)}" fill="#111"/>`;
}

function centeredGlyphPath(font, text, centerX, centerY, fontSize) {
  const initialPath = font.getPath(text, 0, 0, fontSize);
  const bounds = initialPath.getBoundingBox();
  const originX = centerX - ((bounds.x1 + bounds.x2) / 2);
  const originY = centerY - ((bounds.y1 + bounds.y2) / 2);
  const glyphPath = font.getPath(text, originX, originY, fontSize);
  return `<path d="${glyphPath.toPathData(2)}" fill="#111"/>`;
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
  const nameCenters = nameLines.length === 1 ? [558] : [520, 590];
  const nameSvg = nameLines
    .map((line, index) => centeredGlyphPath(nameFont, line, 527, nameCenters[index], fontSize))
    .join('');
  const dateText = cleanText(date, 24);
  const timeText = cleanText(endTime ? `${startTime} a ${endTime}` : startTime, 28);
  const phoneText = formatInvitationPhone(phone);

  const overlay = Buffer.from(`
    <svg width="1054" height="1492" xmlns="http://www.w3.org/2000/svg">
      ${nameSvg}
      ${centeredTextPath(detailsFont, dateText, 395, 822, 44)}
      ${centeredTextPath(detailsFont, timeText, 395, 987, 44)}
      ${centeredTextPath(detailsFont, phoneText, 395, 1152, 44)}
    </svg>
  `);

  return sharp(BIRTHDAY_INVITATION_TEMPLATE)
    .composite([{ input: overlay, top: 0, left: 0 }])
    .png()
    .toBuffer();
}
