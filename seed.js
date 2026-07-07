// Seed 6 fake users (3 women / 3 men) with real portrait photos
// (public/assets/seeds/, Unsplash license) so the flows can be tested
// without a crowd. Run: node seed.js
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const { db } = require('./lib/db');
const { processUpload, DEFAULT_FACE_BOX } = require('./lib/images');

const SEED_DIR = path.join(__dirname, 'public', 'assets', 'seeds');

function photoDataUrl(file) {
  const buf = fs.readFileSync(path.join(SEED_DIR, file));
  return 'data:image/jpeg;base64,' + buf.toString('base64');
}

// Face boxes detected once with the same client-side detector users go through
// (face-api.js), so the glass sits on the real face in every seed photo too.
const BOXES = {
  'w1.jpg': { x: 0.1321, y: 0.0473, w: 0.7996, h: 0.7524 },
  'w1b.jpg': { x: 0.0, y: 0.0521, w: 0.7726, h: 0.7285 },
  'w2.jpg': { x: 0.1701, y: 0.0745, w: 0.6483, h: 0.631 },
  'w2b.jpg': { x: 0.1653, y: 0.0425, w: 0.6517, h: 0.6006 },
  'w3.jpg': { x: 0.3143, y: 0.2882, w: 0.2773, h: 0.2514 },
  'w3b.jpg': { x: 0.3124, y: 0.1649, w: 0.2684, h: 0.2466 },
  'm1.jpg': { x: 0.0367, y: 0.0, w: 0.9075, h: 0.767 },
  'm1b.jpg': { x: 0.0304, y: 0.0, w: 0.918, h: 0.7692 },
  'm2.jpg': { x: 0.1436, y: 0.0478, w: 0.7015, h: 0.6041 },
  'm2b.jpg': { x: 0.1132, y: 0.0, w: 0.768, h: 0.5998 },
  'm3.jpg': { x: 0.0882, y: 0.0786, w: 0.7382, h: 0.6731 },
  'm3b.jpg': { x: 0.0865, y: 0.088, w: 0.7403, h: 0.6657 },
};

const USERS = [
  { username: 'seed_ananya', firstName: 'Ananya', age: 24, gender: 'woman', height: "5'4\"", job: 'UX designer', education: 'NID Ahmedabad',
    photos: ['w1.jpg', 'w1b.jpg'],
    about: 'Designer by trade, over-thinker by hobby. I collect tiny rituals — the 7am coffee, the walk home the long way. Looking for someone whose curiosity outlasts the first week.',
    promptQs: ['Top 3 movies or songs', 'My simple pleasure', 'We\'ll get along if'],
    prompts: ['Tamasha · Piku · anything by Prateek Kuhad', 'Filter coffee at 7am before the city wakes up', 'you can lose an argument gracefully'] },
  { username: 'seed_mira', firstName: 'Mira', age: 26, gender: 'woman', height: "5'6\"", job: 'Doctor (resident)', education: 'St. John\'s Medical',
    photos: ['w2.jpg', 'w2b.jpg'],
    about: 'Resident doctor, so my hours are chaos and my sleep is a rumour. I recharge on long aimless walks and playlists that have no business being that emotional. Tell me something true.',
    promptQs: ['Top 3 movies or songs', 'A weirdly specific thing that makes me happy', 'The question I wish people asked me'],
    prompts: ['Interstellar · Dear Zindagi · Coke Studio deep cuts', 'Long walks with no destination and no phone', 'you ask follow-up questions'] },
  { username: 'seed_zoya', firstName: 'Zoya', age: 23, gender: 'woman', height: "5'3\"", job: 'Content strategist', education: 'Christ University',
    photos: ['w3.jpg', 'w3b.jpg'],
    about: 'I write for a living and argue about food for free. Bookstores are my happy place and I will judge you (kindly) by your pani-puri stance. Warm, a little sarcastic, fully present.',
    promptQs: ['Top 3 movies or songs', 'A free Tuesday and zero guilt — I would', 'My most controversial food opinion'],
    prompts: ['Zindagi Na Milegi Dobara · La La Land · old Lucky Ali', 'Bookstores where nobody talks to me', 'you have strong opinions about street food'] },
  { username: 'seed_arjun', firstName: 'Arjun', age: 27, gender: 'man', height: "5'11\"", job: 'Backend engineer', education: 'IIT Guwahati',
    photos: ['m1.jpg', 'm1b.jpg'],
    about: 'I build systems that (mostly) don\'t fall over, and I plan trips more lovingly than I take them. Quiet until I trust you, then relentlessly curious. Big on staying, small on flaking.',
    promptQs: ['Top 3 movies or songs', 'A weirdly specific thing that makes me happy', 'The hill I will die on'],
    prompts: ['The Dark Knight · Swades · Radiohead on loop', 'Debugging something at 2am and it finally works', 'you think planning the trip IS the trip'] },
  { username: 'seed_kabir', firstName: 'Kabir', age: 25, gender: 'man', height: "5'9\"", job: 'Product manager', education: 'BITS Pilani',
    photos: ['m2.jpg', 'm2b.jpg'],
    about: 'PM who genuinely likes people and their weird stories. I make an unreasonable second cup of chai every evening and would love someone to share the silence with. Steady, warm, a good listener.',
    promptQs: ['Top 3 movies or songs', 'My simple pleasure', 'We\'ll get along if'],
    prompts: ['Rockstar · Inception · Nusrat saab', 'Second cup of chai that nobody knows about', 'you can sit in comfortable silence'] },
  { username: 'seed_dev', firstName: 'Dev', age: 28, gender: 'man', height: "6'0\"", job: 'Architect', education: 'CEPT University',
    photos: ['m3.jpg', 'm3b.jpg'],
    about: 'Architect who notices doorways and light before anything else. I sketch strangers (kindly), lose afternoons in coffee shops, and believe attention is the truest form of affection.',
    promptQs: ['Top 3 movies or songs', 'What my friends roast me for', 'We\'ll get along if'],
    prompts: ['Barfi · Grand Budapest Hotel · Bombay Jayashri', 'Sketching strangers in coffee shops (kindly)', 'you notice buildings the way I do'] },
];

const hash = bcrypt.hashSync('seed1234', 8);
let created = 0;

USERS.forEach((u, n) => {
  if (db.prepare('SELECT id FROM users WHERE username = ?').get(u.username)) {
    console.log(`- ${u.username} already exists, skipping`);
    return;
  }
  const info = db.prepare(`
    INSERT INTO users (username, password_hash, first_name, age, gender, height, job, education,
                       prompt1, prompt2, prompt3, prompt1_q, prompt2_q, prompt3_q, about)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(u.username, hash, u.firstName, u.age, u.gender, u.height, u.job, u.education,
    ...u.prompts, ...(u.promptQs || ['Top 3 movies or songs', 'My simple pleasure', "We'll get along if"]), u.about || '');
  const userId = Number(info.lastInsertRowid);

  for (let idx = 0; idx < 2; idx++) {
    const file = u.photos[idx];
    const dataUrl = photoDataUrl(file);
    const pInfo = db.prepare(`
      INSERT INTO photos (user_id, idx, width, height, face_x, face_y, face_w, face_h, tile_order)
      VALUES (?, ?, 0, 0, 0, 0, 0, 0, '[]')
    `).run(userId, idx);
    const photoId = Number(pInfo.lastInsertRowid);
    const meta = processUpload(photoId, dataUrl, BOXES[file] || DEFAULT_FACE_BOX);
    db.prepare(`
      UPDATE photos SET width = ?, height = ?, face_x = ?, face_y = ?, face_w = ?, face_h = ?, tile_order = ?
      WHERE id = ?
    `).run(meta.width, meta.height, meta.faceBox.x, meta.faceBox.y, meta.faceBox.w, meta.faceBox.h,
      JSON.stringify(meta.tileOrder), photoId);
  }
  created++;
  console.log(`✓ ${u.firstName} (${u.gender}) — @${u.username} / seed1234`);
});

// Give the seed users a status of the day so the strip has life.
const STATUSES = {
  seed_ananya: ['mood', 'pretending my third coffee is a personality'],
  seed_mira: ['today', 'rained. read on the balcony between shifts. no regrets.'],
  seed_zoya: ['thought', 'auto drivers are the last honest philosophers'],
  seed_arjun: ['song', 'Kho Gaye Hum Kahan — on loop since the deploy broke'],
  seed_kabir: ['mood', 'chai-adjacent and quietly optimistic'],
  seed_dev: ['thought', 'good buildings, like good people, reveal themselves slowly'],
};
for (const [uname, [type, text]] of Object.entries(STATUSES)) {
  const u = db.prepare('SELECT id FROM users WHERE username = ?').get(uname);
  if (u) db.prepare("INSERT OR REPLACE INTO statuses (user_id, type, text, created_at) VALUES (?, ?, ?, datetime('now'))").run(u.id, type, text);
}

console.log(`\nSeeded ${created} users. All passwords: seed1234`);
