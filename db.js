const fs = require('fs');
const path = require('path');

const DB_FILE = path.join(__dirname, 'data.json');

const DEFAULT = { users: {}, territories: {}, clans: {}, clan_members: {}, purchases: [] };

function load() {
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch {
    return JSON.parse(JSON.stringify(DEFAULT));
  }
}

function save(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

let data = load();

module.exports = {
  get: () => data,
  save: () => save(data),
  reload: () => { data = load(); },
};
