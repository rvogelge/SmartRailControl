// Automated operation of Fahrstraßen (routes): a route is a fixed sequence of steps,
// optionally a loop; a step is one block or several parallel blocks (e.g. station
// tracks). A run follows one locomotive along it:
//
// - Whenever the locomotive is in a block of the route, the blocks of the next step are
//   looked at: the first one (in the order listed) that is free and connected by track
//   is chosen, and the turnouts on the way there are set. If none is free, the
//   locomotive is stopped in its block (the driver restarts it once one is free; the
//   turnouts are set then). A block already chosen is kept while it stays free.
// - At the end of a sequence that is not a loop, the locomotive is stopped: run finished.
// - If the locomotive leaves the route, or two blocks of the sequence have no track
//   connection, it is stopped and the run ends with an error.
//
// The run is re-evaluated after every block change (BlockTracker), route or layout change.

const TrackCatalog = require('./public/trackCatalog');

class RouteRunner {
  // tracker: BlockTracker · getTiles() · getRoutes() · setTurnout(id, state): Promise
  // stopLoco(name) · log(text)
  constructor({ tracker, getTiles, getRoutes, setTurnout, stopLoco, log = () => {} }) {
    this.tracker = tracker;
    this.getTiles = getTiles;
    this.getRoutes = getRoutes;
    this.setTurnout = setTurnout;
    this.stopLoco = stopLoco;
    this.log = log;
    this.runs = new Map(); // route id -> run
    this.queue = Promise.resolve(); // evaluations run one after another
  }

  // Starts a run for `loco`, which has to be in a block of the route.
  start(routeId, loco) {
    const route = this.getRoutes().find((r) => r.id === routeId);
    if (!route) throw new Error('Unknown route.');
    if (route.steps.length < 2) throw new Error('A route needs at least two steps.');
    if (!loco) throw new Error('Choose a locomotive.');
    const block = this.tracker.blockOfLoco(loco);
    if (!block || !route.steps.some((step) => step.includes(block))) {
      const error = new Error(`${loco} is not in a block of this route.`);
      error.code = 'locoNotInRoute';
      throw error;
    }
    const other = [...this.runs.values()].find((r) => r.loco === loco && !r.ended && r.routeId !== routeId);
    if (other) throw new Error(`${loco} already runs on another route.`);
    const index = route.steps.findIndex((step) => step.includes(block));
    this.runs.set(routeId, { routeId, loco, status: 'starting', index, current: block, next: null, ended: false, since: new Date().toISOString() });
    this.log(`[routes] ${route.name}: started with ${loco}`);
    return this.evaluate();
  }

  // Ends the run (the locomotive is not touched).
  stop(routeId) {
    const run = this.runs.get(routeId);
    if (!run) return false;
    this.runs.delete(routeId);
    this.log(`[routes] run of ${run.loco} stopped`);
    return true;
  }

  // Looks at every run again; resolves when done.
  evaluate() {
    this.queue = this.queue
      .then(async () => {
        for (const run of [...this.runs.values()]) {
          if (!run.ended) await this.evaluateRun(run);
        }
      })
      .catch((error) => this.log(`[routes] ${error.message}`));
    return this.queue;
  }

  end(run, status, message) {
    run.status = status;
    run.message = message;
    run.ended = true;
    this.stopLoco(run.loco);
    this.log(`[routes] ${run.loco}: ${message}, locomotive stopped`);
  }

  async evaluateRun(run) {
    const route = this.getRoutes().find((r) => r.id === run.routeId);
    if (!route) {
      this.runs.delete(run.routeId);
      return;
    }
    const { steps } = route;
    const current = this.tracker.blockOfLoco(run.loco);
    if (!current || !steps.some((step) => step.includes(current))) {
      this.end(run, 'error', current ? 'left the route' : 'no longer in a block');
      run.code = current ? 'leftRoute' : 'notInBlock';
      return;
    }

    // Position in the sequence (a block may appear in more than one step of a loop).
    if (!steps[run.index] || !steps[run.index].includes(current)) {
      const following = steps.findIndex((step, i) => step.includes(current) && i > run.index);
      run.index = following !== -1 ? following : steps.findIndex((step) => step.includes(current));
    }
    const moved = run.current !== current;
    run.current = current;
    if (moved) run.next = null;

    const nextIndex = run.index + 1 < steps.length ? run.index + 1 : route.loop ? 0 : null;
    if (nextIndex === null) {
      run.next = null;
      this.end(run, 'finished', 'end of the route');
      run.code = 'finished';
      return;
    }

    // Blocks of the next step that can be reached, in the order listed.
    const tiles = this.getTiles();
    const occupied = this.tracker.getLive();
    const reachable = steps[nextIndex]
      .filter((id) => id !== current)
      .map((id) => ({ id, path: TrackCatalog.findPath(tiles, current, id) }))
      .filter((c) => c.path);
    if (reachable.length === 0) {
      run.next = steps[nextIndex][0];
      this.end(run, 'error', 'no track connection to the next step');
      run.code = 'noConnection';
      return;
    }
    const free = reachable.filter((c) => !occupied[c.id]);
    if (free.length === 0) {
      run.next = reachable[0].id;
      if (run.status !== 'waiting') {
        run.status = 'waiting';
        run.code = 'waiting';
        this.stopLoco(run.loco);
        this.log(`[routes] ${run.loco}: no free block ahead, locomotive stopped`);
      }
      return;
    }
    // Keep the block already chosen while it is free, so turnouts do not flip back and forth.
    const chosen = free.find((c) => c.id === run.next) || free[0];
    run.next = chosen.id;

    const byId = new Map(tiles.map((t) => [t.id, t]));
    for (const [id, state] of Object.entries(chosen.path.turnouts)) {
      const tile = byId.get(id);
      if (tile && tile.state !== state) await this.setTurnout(id, state);
    }
    // After waiting, the driver restarts the locomotive.
    run.code = run.status === 'waiting' || (run.code === 'free' && !moved) ? 'free' : 'running';
    run.status = 'running';
  }

  // A locomotive was renamed (newName) or removed (null): runs follow it or end.
  renameLoco(oldName, newName) {
    [...this.runs].forEach(([id, run]) => {
      if (run.loco !== oldName) return;
      if (newName) run.loco = newName;
      else this.runs.delete(id);
    });
  }

  // { route id: { loco, status, code, current, next, ended, message } }
  getLive() {
    return Object.fromEntries(
      [...this.runs].map(([id, r]) => [
        id,
        { loco: r.loco, status: r.status, code: r.code || r.status, current: r.current, next: r.next, ended: r.ended, message: r.message || null }
      ])
    );
  }
}

module.exports = RouteRunner;
