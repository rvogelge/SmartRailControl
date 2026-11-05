// Block signalling: which blocks of the layout are occupied, and by which locomotive.
//
// A block starts at a contact track marked as block start and runs in the direction of
// its arrow up to the next block-start contact or turnout (TrackCatalog.findBlocks).
// When a block-start contact fires, its block becomes occupied, and the block the train
// came from is freed; its locomotive moves on into the new block.
//
// Consistency:
// - A locomotive is in one block at most: assigning it to another block by hand is
//   refused until its block is freed.
// - Where the train came from: of the occupied blocks leading into the contact (over any
//   turnout route), the one whose locomotive is running (speed > 0); turnout positions do
//   not matter. A single block with an unknown train counts too (no speed to check). If
//   that leaves no single block, none is freed and the new block is occupied by an
//   unknown train.
//
// Blocks can also be set and freed by hand. Occupancy is saved with the settings.

const TrackCatalog = require('./public/trackCatalog');

const MAX_LOCO_LENGTH = 40;

const cleanLoco = (loco) => {
  const text = String(loco ?? '').trim().slice(0, MAX_LOCO_LENGTH);
  return text || null;
};

class BlockTracker {
  // getTiles(): layout tiles · load(): saved { id: { loco } } · save(state)
  // getLocoSpeed(name): current speed of a locomotive, or null when unknown
  constructor({ getTiles, load = () => ({}), save = () => {}, getLocoSpeed = () => null }) {
    this.getTiles = getTiles;
    this.getLocoSpeed = getLocoSpeed;
    this.loadState = load;
    this.saveState = save;
    this.reload();
  }

  // Takes over the saved occupancy (at start and after switching the data file).
  reload() {
    this.occupied = new Map(); // block id -> { loco, since }
    Object.entries(this.loadState() || {}).forEach(([id, value]) => {
      this.occupied.set(id, { loco: cleanLoco(value && value.loco), since: (value && value.since) || null });
    });
    this.prune();
  }

  blocks() {
    return TrackCatalog.findBlocks(this.getTiles());
  }

  save() {
    this.saveState(Object.fromEntries(this.occupied));
  }

  // Drops occupancy of blocks that no longer exist (contact removed or no longer a block start).
  prune() {
    const ids = new Set(this.blocks().map((b) => b.id));
    let changed = false;
    [...this.occupied.keys()].forEach((id) => {
      if (!ids.has(id)) {
        this.occupied.delete(id);
        changed = true;
      }
    });
    if (changed) this.save();
  }

  // The block a train entering `block` comes from, or null when that cannot be told.
  // Returns { from, ambiguous: [ids] }.
  sourceOf(block, blocks) {
    const candidates = blocks.filter((b) => b.id !== block.id && b.next.includes(block.id) && this.occupied.has(b.id));
    const locoOf = (b) => this.occupied.get(b.id).loco;
    const moving = candidates.filter((b) => locoOf(b) && Number(this.getLocoSpeed(locoOf(b))) > 0);
    if (moving.length === 1) return { from: moving[0], ambiguous: [] };
    if (moving.length === 0 && candidates.length === 1 && !locoOf(candidates[0])) return { from: candidates[0], ambiguous: [] };
    return { from: null, ambiguous: (moving.length ? moving : candidates).map((b) => b.id) };
  }

  // A contact track switched on. Returns { block, loco, freed: [ids], ambiguous: [ids] }
  // or null when the contact does not start a block.
  contactOn(tileId) {
    const blocks = this.blocks();
    const block = blocks.find((b) => b.id === tileId);
    if (!block) return null;

    const { from, ambiguous } = this.sourceOf(block, blocks);
    const current = this.occupied.get(block.id);
    const loco = (from && this.occupied.get(from.id).loco) || (current && current.loco) || null;

    if (from) this.occupied.delete(from.id);
    // The locomotive is now here and nowhere else.
    if (loco) {
      [...this.occupied].forEach(([id, value]) => {
        if (id !== block.id && value.loco === loco) this.occupied.delete(id);
      });
    }
    this.occupied.set(block.id, { loco, since: current ? current.since : new Date().toISOString() });
    this.save();
    return { block: block.id, loco, freed: from ? [from.id] : [], ambiguous };
  }

  // The block a locomotive is in, or null.
  blockOfLoco(loco) {
    const entry = [...this.occupied].find(([, value]) => value.loco === loco);
    return entry ? entry[0] : null;
  }

  // By hand: occupied with an optional loco name, or free.
  set(blockId, { occupied, loco } = {}) {
    if (!this.blocks().some((b) => b.id === blockId)) throw new Error('Unknown block.');
    if (occupied) {
      const name = cleanLoco(loco);
      const elsewhere = name && this.blockOfLoco(name);
      if (elsewhere && elsewhere !== blockId) {
        const error = new Error(`${name} is already in another block: free that block first.`);
        error.code = 'locoInBlock';
        error.block = elsewhere;
        error.loco = name;
        throw error;
      }
      const current = this.occupied.get(blockId);
      this.occupied.set(blockId, { loco: name, since: current ? current.since : new Date().toISOString() });
    } else {
      this.occupied.delete(blockId);
    }
    this.save();
    return this.getLive();
  }

  // { block id: { loco } } for the occupied blocks.
  getLive() {
    return Object.fromEntries([...this.occupied].map(([id, { loco }]) => [id, { loco }]));
  }
}

BlockTracker.MAX_LOCO_LENGTH = MAX_LOCO_LENGTH;

module.exports = BlockTracker;
