// Block signalling: which blocks of the layout are occupied, and by which locomotive.
//
// A block starts at a contact track marked as block start and runs in the direction of
// its arrow up to the next block-start contact (TrackCatalog.findBlocks). When a
// block-start contact fires, its block becomes occupied; a block that leads into this
// contact and is occupied is freed, and its locomotive moves on into the new block.
// Blocks can also be set and freed by hand. Occupancy is saved with the settings.

const TrackCatalog = require('./public/trackCatalog');

const MAX_LOCO_LENGTH = 40;

const cleanLoco = (loco) => {
  const text = String(loco ?? '').trim().slice(0, MAX_LOCO_LENGTH);
  return text || null;
};

class BlockTracker {
  // getTiles(): layout tiles · load(): saved { id: { loco } } · save(state)
  constructor({ getTiles, load = () => ({}), save = () => {} }) {
    this.getTiles = getTiles;
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

  // A contact track switched on. Returns { block, loco, freed: [ids] } or null when the
  // contact does not start a block.
  contactOn(tileId) {
    const blocks = this.blocks();
    const block = blocks.find((b) => b.id === tileId);
    if (!block) return null;

    // Blocks that lead into this contact and are occupied: the train comes from there.
    const previous = blocks.filter((b) => b.id !== block.id && b.next.includes(block.id) && this.occupied.has(b.id));
    const from = previous.find((b) => this.occupied.get(b.id).loco) || previous[0];
    const current = this.occupied.get(block.id);
    const loco = (from && this.occupied.get(from.id).loco) || (current && current.loco) || null;

    previous.forEach((b) => this.occupied.delete(b.id));
    this.occupied.set(block.id, { loco, since: current ? current.since : new Date().toISOString() });
    this.save();
    return { block: block.id, loco, freed: previous.map((b) => b.id) };
  }

  // By hand: occupied with an optional loco name, or free.
  set(blockId, { occupied, loco } = {}) {
    if (!this.blocks().some((b) => b.id === blockId)) throw new Error('Unknown block.');
    if (occupied) {
      const current = this.occupied.get(blockId);
      this.occupied.set(blockId, { loco: cleanLoco(loco), since: current ? current.since : new Date().toISOString() });
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
