const fs = require('fs');
const path = require('path');
const { reduceManagedTradeEvents } = require('./workflow');

function ensureDirForFile(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

class LocalEventStore {
  constructor({
    eventsPath,
    relayStatePath = null
  }) {
    if (eventsPath == null || String(eventsPath).trim() === '') {
      throw new Error('eventsPath is required');
    }
    this.eventsPath = String(eventsPath);
    this.relayStatePath = relayStatePath == null ? null : String(relayStatePath);
  }

  append(event) {
    if (event == null || typeof event !== 'object') {
      throw new Error('event must be an object');
    }
    ensureDirForFile(this.eventsPath);
    fs.appendFileSync(this.eventsPath, `${JSON.stringify(event)}\n`);
    return event;
  }

  readAll() {
    if (!fs.existsSync(this.eventsPath)) {
      return [];
    }
    return fs.readFileSync(this.eventsPath, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }

  listThread(threadId) {
    return this.readAll().filter((event) => {
      const tags = Array.isArray(event.tags) ? event.tags : [];
      return tags.some((tag) => Array.isArray(tag) && tag[0] === 'd' && tag[1] === threadId);
    });
  }

  reduceThread(threadId, options = {}) {
    return reduceManagedTradeEvents(this.listThread(threadId), options);
  }

  readRelayState() {
    if (this.relayStatePath == null || !fs.existsSync(this.relayStatePath)) {
      return {};
    }
    return JSON.parse(fs.readFileSync(this.relayStatePath, 'utf8'));
  }

  updateRelayCursor(relayUrl, cursorLike) {
    if (this.relayStatePath == null) {
      throw new Error('relayStatePath is required for cursor persistence');
    }
    const relayKey = String(relayUrl || '').trim();
    if (relayKey === '') {
      throw new Error('relayUrl is required');
    }
    const current = this.readRelayState();
    current[relayKey] = {
      relayUrl: relayKey,
      lastEventId: cursorLike?.lastEventId == null ? null : String(cursorLike.lastEventId),
      lastSeenAt: cursorLike?.lastSeenAt == null ? null : Number(cursorLike.lastSeenAt)
    };
    ensureDirForFile(this.relayStatePath);
    fs.writeFileSync(this.relayStatePath, JSON.stringify(current, null, 2));
    return current[relayKey];
  }
}

module.exports = {
  LocalEventStore
};
