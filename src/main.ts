// Memory.printCpuInfo=true;

// When compiling TS to JS and bundling with rollup, the line numbers and file names in error messages change
// This utility uses source maps to get the line numbers and file names of the original, TS source code
import * as utils from "utils";
import { ErrorMapper } from "utils/ErrorMapper";

declare global {
  type Role =
    | "carrier"
    | "explorer"
    | "harvester"
    | "infantry"
    | "reserver"
    | "transferer"
    | "upgrader"
    | "worker";

  type Action = "reserveController";

  type Destination =
    | AnyStructure
    | ConstructionSite
    | Creep
    | Flag
    | PowerCreep
    | Resource
    | RoomPosition
    | Ruin
    | Source
    | Structure
    | Tombstone;

  type DestinationId = Id<
    AnyStructure | Structure | ConstructionSite | Source | Creep | Resource | Tombstone | Ruin | PowerCreep
  >;

  type EnergySource = Resource | Ruin | StructureContainer | StructureLink | StructureStorage | Tombstone;

  interface Memory {
    color?: Record<string, ColorConstant>;
    cpuLog?: Record<string, CpuLogEntry>;
    cpuUsedRatio?: number;
    haveCreeps?: boolean;
    haveSpawns?: boolean;
    hostileCreepCost?: number;
    lackedEnergySinceTime?: number;
    maxTickLimit?: number;
    ownedRoomCount?: number;
    plan?: Plan;
    printCpuInfo?: boolean;
    signTexts?: string[];
    totalEnergy?: number;
    totalEnergyCap?: number;
    totalEnergyRatio?: number;
    totalEnergyRatioDelta?: number;
    username?: string;
  }

  interface Plan {
    controllersToReserve?: Id<StructureController>[];
    maxRoomEnergy?: number;
    maxRoomEnergyCap?: number;
    minTicksToDowngrade?: number;
    needHarvesters?: boolean;
    needInfantry?: boolean;
    needReservers?: boolean;
    needTransferers?: boolean;
  }

  interface RoomMemory {
    canOperate?: boolean;
    claimIsSafe?: boolean;
    costMatrix?: number[];
    costMatrixCreeps?: number[];
    costMatrixLayout?: number[];
    costMatrixRamparts?: number[];
    energyRatio?: number;
    energyRatioDelta?: number;
    lackedEnergySinceTime?: number;
    maxHitsToRepair?: number /* repair ramparts & stuff evenly */;
    polyPoints?: RoomPosition[] /* visualize paths for debugging etc. */;
    resetLayout?: boolean;
    safeForCreeps?: boolean;
    score?: number;
    stickyEnergy?: Record<Id<AnyStoreStructure>, number>;
    stickyEnergyDelta?: Record<Id<AnyStoreStructure>, number>;
    towerLastTarget?: Id<Creep | PowerCreep>;
    towerLastTargetHits?: number;
    towerMaxRange?: number;
  }

  interface CreepMemory {
    build?: Id<ConstructionSite>;
    delivering?: boolean;
    destination?: DestinationId | RoomPosition;
    lastMoveTime?: number;
    lastTimeFull?: number;
    path?: RoomPosition[];
    pos?: RoomPosition;
    retrieve?: Id<Structure | Tombstone | Ruin | Resource>;
    room?: string;
    sourceId?: Id<Source>;
    spawnStartTime?: number;
    stroke?: string;
    strokeWidth?: number;
    transferTo?: Id<Structure>;
    workStartTime?: number;
  }

  interface Task {
    action: Action;
    destination: Destination;
  }

  interface ScoredTarget {
    score: number;
    target: Creep | PowerCreep | AnyOwnedStructure | AnyStructure;
  }

  interface ScoredPos {
    score: number;
    pos: RoomPosition;
  }

  interface CpuLogEntry {
    before: number;
    after: number;
  }

  interface CpuLogEntryFinal {
    name: string;
    cpu: number;
  }
}

// Main loop
export const loop = ErrorMapper.wrapLoop(() => {
  Memory.cpuLog = {}; // before everything!
  utils.logCpu("main");
  const rooms = Object.values(Game.rooms)
    .map(value => ({ value, sort: Math.random() })) /* persist sort values */
    .sort((a, b) => a.sort - b.sort) /* sort */
    .map(({ value }) => value); /* remove sort values */
  for (const room of rooms) handleRoom(room); //handle rooms in random order to give each a fair change of gotSpareCpu()
  if ((Memory.maxTickLimit || 0) < Game.cpu.tickLimit) Memory.maxTickLimit = Game.cpu.tickLimit;
  if (Math.random() < 0.1) {
    for (const key in Memory.rooms) {
      if (!Game.rooms[key]) {
        delete Memory.rooms[key].costMatrix;
        delete Memory.rooms[key].costMatrixLayout;
        delete Memory.rooms[key].costMatrixRamparts;
      }
    }
    for (const key in Memory.creeps) {
      if (!Game.creeps[key]) delete Memory.creeps[key];
    }
    purgeFlags();
    purgeFlagsMemory();
    utils.removeConstructionSitesInRoomsWithoutVisibility();
  }
  if (!Memory.username) utils.setUsername();
  checkWipeOut();
  if (Math.random() < 0.1 || utils.gotSpareCpu()) updatePlan();
  spawnCreeps();
  updateFlagAttack();
  updateFlagClaim();
  updateFlagReserve();
  if (utils.gotSpareCpu()) updateFlagDismantle();
  handleCreeps();
  if (Game.time % 10 === 0) utils.updateEnergy();
  Memory.cpuUsedRatio = Game.cpu.getUsed() / Game.cpu.limit;
  utils.logCpu("main");
  utils.cpuInfo(); // after everything!
});

function updatePlan() {
  Memory.plan = {
    controllersToReserve: utils.getControllersToReserve().map(controller => controller.id),
    needHarvesters: getSourceToHarvest() ? true : false,
    needInfantry: needInfantry(),
    needReservers: needReservers(),
    needTransferers: getStoragesRequiringTransferer().length > 0,
    maxRoomEnergy: Math.max(...Object.values(Game.rooms).map(r => r.energyAvailable)),
    maxRoomEnergyCap: Math.max(...Object.values(Game.rooms).map(r => r.energyCapacityAvailable)),
    minTicksToDowngrade: getMinTicksToDowngrade()
  };
}

function getMinTicksToDowngrade() {
  const value = Math.min(
    ...Object.values(Game.rooms)
      .filter(room => room.controller && room.controller.my)
      .map(room => room.controller?.ticksToDowngrade || Number.POSITIVE_INFINITY)
  );
  return value;
}

function needExplorers() {
  return (
    utils.getCreepCountByRole("explorer") < 1 &&
    Object.values(Game.rooms).filter(
      room =>
        room.controller &&
        room.controller.my &&
        CONTROLLER_STRUCTURES[STRUCTURE_OBSERVER][room.controller.level] > 0
    ).length < 1
  );
}

function areAllSpawnsFull() {
  for (const room of Object.values(Game.rooms))
    if (room.energyAvailable < room.energyCapacityAvailable) return false;
  return true;
}

function handleCreeps() {
  utils.logCpu("handleCreeps()");
  for (const creep of Object.values(Game.creeps)) {
    utils.logCpu("creep: " + creep);
    if (!creep.spawning) {
      const role = creep.name.charAt(0).toLowerCase();
      if (role === "c") handleCarrier(creep);
      else if (role === "e") handleExplorer(creep);
      else if (role === "h") handleHarvester(creep);
      else if (role === "i") handleInfantry(creep);
      else if (role === "r") handleReserver(creep);
      else if (role === "t") handleTransferer(creep);
      else if (role === "u") handleUpgrader(creep);
      else if (role === "w") handleWorker(creep);

      if (creep.memory.pos && !utils.isPosEqual(creep.memory.pos, creep.pos))
        creep.memory.lastMoveTime = Game.time;
      if (utils.isFull(creep)) creep.memory.lastTimeFull = Game.time;
      creep.memory.pos = creep.pos;
    } else if (!creep.memory.spawnStartTime) {
      creep.memory.spawnStartTime = Game.time;
    }
    utils.logCpu("creep: " + creep);
  }
  utils.logCpu("handleCreeps()");
}

function handleExplorer(creep: Creep) {
  if (utils.isStuck(creep)) {
    delete creep.memory.path;
    delete creep.memory.destination;
    utils.moveRandomDirection(creep);
    return;
  }
  creep.notifyWhenAttacked(false);
  const controller = creep.room.controller;
  if (controller && (controller.sign?.username ?? "") !== Memory.username) {
    const outcome = creep.signController(controller, getSignText());
    if (outcome === ERR_NOT_IN_RANGE) move(creep, controller);
  } else if (creep.pos.roomName !== creep.memory.pos?.roomName || !moveTowardMemory(creep)) {
    const accessibleExits = creep.room
      .find(FIND_EXIT)
      .filter(exit => exit.lookFor(LOOK_STRUCTURES).filter(utils.isObstacle).length < 1);
    const randomIndex = Math.floor(Math.random() * accessibleExits.length);
    const destination = accessibleExits[randomIndex];
    if (destination) {
      if (move(creep, destination) === ERR_NO_PATH) {
        delete creep.memory.destination;
      } else {
        utils.setDestination(creep, destination);
      }
    }
  }
}

function handleUpgrader(creep: Creep) {
  const room = getCreepTargetRoom(creep);
  if (!room) return;
  const controller = room.controller;
  if (!controller) return;

  if (Math.random() < 0.1 && creep.pos.lookFor(LOOK_STRUCTURES).length > 0) {
    move(creep, getUpgraderSpot(room) ?? controller.pos); //stay out of roads and stuff
    return;
  }

  if (utils.getEnergy(creep) < 1) {
    const storage = getStorage(room);
    if (!storage) return;
    const withdrawOutcome = creep.withdraw(storage, RESOURCE_ENERGY);
    if (withdrawOutcome === ERR_NOT_IN_RANGE) move(creep, getUpgraderSpot(room) ?? storage.pos);
  } else {
    const outcome = creep.upgradeController(controller);
    if (outcome === ERR_NOT_IN_RANGE) move(creep, getUpgraderSpot(room) ?? controller.pos);
  }
}

function handleWorker(creep: Creep) {
  if (utils.getEnergy(creep) < 1) delete creep.memory.build;
  else if (utils.isFull(creep)) delete creep.memory.retrieve;

  if (utils.getEnergy(creep) < 1) {
    workerRetrieveEnergy(creep);
    return;
  }
  return repairLocal(creep) || repairRoom(creep) || build(creep) || dismantle(creep);
}

function build(creep: Creep) {
  let destination;
  const oldDestination = creep.memory.build;
  if (typeof oldDestination === "string") {
    destination = Game.getObjectById(oldDestination);
    if (!destination) delete creep.memory.build;
  }
  if (!destination || !(destination instanceof ConstructionSite)) {
    destination = getBuildSite(creep);
    if (destination) utils.setDestination(creep, destination);
  }
  if (destination instanceof ConstructionSite) {
    creep.memory.build = destination.id;
    if (creep.build(destination) === ERR_NOT_IN_RANGE) move(creep, destination);
    return true;
  }
  return false;
}

function getBuildSite(creep: Creep) {
  const room = getCreepTargetRoom(creep);
  if (!room) return;
  return room
    .find(FIND_MY_CONSTRUCTION_SITES)
    .map(site => ({
      site,
      sort: utils.getGlobalRange(creep.pos, utils.getPos(site)) + getBuildSitePriority(site) * 50
    })) /* persist sort values */
    .sort((a, b) => a.sort - b.sort) /* sort */
    .map(({ site }) => site) /* remove sort values */[0];
}

function getCreepTargetRoom(creep: Creep) {
  if (creep.memory.room) return Game.rooms[creep.memory.room];
  return;
}

function dismantle(creep: Creep) {
  const flag = Game.flags.dismantle;
  if (!flag || !flag.room) return false;
  if (flag.pos.roomName !== creep.memory.room) return false;
  const targets = flag.pos.lookFor(LOOK_STRUCTURES);
  if (targets.length < 1) return false;
  const target = targets[0];
  if (creep.dismantle(target) === ERR_NOT_IN_RANGE) {
    move(creep, target);
    return true;
  }
  return false;
}

function moveTowardMemory(creep: Creep) {
  let destination: Destination = Game.flags["creep_" + creep.name];
  if (!destination) {
    const destinationMemory = creep.memory.destination;
    if (typeof destinationMemory === "string") {
      const destinationObject = Game.getObjectById(destinationMemory);
      if (destinationObject) destination = destinationObject;
    }
  }
  if (destination) {
    if (move(creep, destination) === ERR_NO_PATH || utils.getGlobalRange(creep.pos, destination.pos) <= 1)
      utils.resetDestination(creep);
    return true;
  }
  return false;
}

function handleCarrier(creep: Creep) {
  const freeCap = utils.getFreeCap(creep);
  if (!creep.memory.room) creep.memory.room = creep.pos.roomName;
  if (followMemorizedPath(creep)) return;

  if (freeCap < 1) {
    creep.memory.delivering = true;
  } else if (utils.getEnergy(creep) < 1) {
    creep.memory.delivering = false;
    delete creep.memory.transferTo;
  }

  if (utils.isStuck(creep)) {
    utils.moveRandomDirection(creep);
    delete creep.memory.transferTo;
    delete creep.memory.path;
  } else if (creep.pos.roomName !== creep.memory.room) {
    creep.memory.path = utils.getPath(creep.pos, new RoomPosition(25, 25, creep.memory.room), 20);
    followMemorizedPath(creep);
  } else if (!creep.memory.delivering) {
    //fetch
    const source = getNearbyEnergySource(creep.pos, freeCap);
    if (source) {
      delete creep.memory.path;
      retrieveEnergy(creep, source);
    } else {
      const tgt = getCarrierEnergySource(creep, freeCap);
      if (tgt) creep.moveTo(tgt);
      else utils.moveRandomDirection(creep);
    }
  } else {
    //deliver
    const deliverToId = creep.memory.transferTo;
    let deliverTo;
    if (typeof deliverToId === "string") deliverTo = Game.getObjectById(deliverToId);
    if (!deliverTo || utils.isFull(deliverTo))
      deliverTo = getStructureToFillHere(creep.pos) ?? getStructureToFill(creep.pos);
    if (!deliverTo) return;
    const outcome = transfer(creep, deliverTo);
    if (outcome === ERR_NOT_IN_RANGE) {
      move(creep, deliverTo);
      creep.memory.transferTo = deliverTo.id;
    }
  }
}

function getReserverForClaiming() {
  return Object.values(Game.creeps)
    .filter(creep => creep.name.startsWith("R"))
    .map(value => ({
      value,
      sort: utils.getGlobalRange(value.pos, Game.flags.claim.pos)
    })) /* persist sort values */
    .sort((a, b) => a.sort - b.sort) /* sort */
    .map(({ value }) => value) /* remove sort values */[0];
}

function handleReserver(creep: Creep) {
  if ("claim" in Game.flags && getReserverForClaiming().name === creep.name) {
    claim(creep);
    return;
  }
  let destination;
  const oldDestination = creep.memory.destination;
  if (typeof oldDestination === "string") destination = Game.getObjectById(oldDestination);

  if (destination && destination instanceof StructureController) {
    const outcome = creep.reserveController(destination);
    if (outcome === ERR_NOT_IN_RANGE) {
      move(creep, destination);
    } else if (outcome === ERR_INVALID_TARGET) {
      recycleCreep(creep);
    }
  } else {
    const destinations = Memory.plan?.controllersToReserve?.map(id => Game.getObjectById(id));
    if (destinations && destinations.length && destinations[0]) {
      utils.setDestination(creep, destinations[0]);
      move(creep, destinations[0]);
    } else {
      const flag = Game.flags.reserve;
      if (flag) move(creep, flag);
    }
  }
}

function claim(creep: Creep) {
  const flag = Game.flags.claim;
  if (flag.room) {
    const controller = flag.pos.lookFor(LOOK_STRUCTURES).filter(utils.isController)[0];
    if (utils.isReservedByOthers(controller)) {
      if (creep.attackController(controller) === ERR_NOT_IN_RANGE) move(creep, controller);
    } else {
      if (creep.claimController(controller) === ERR_NOT_IN_RANGE) move(creep, controller);
    }
  } else {
    move(creep, flag);
  }
}

function handleTransferer(creep: Creep) {
  const upstreamId = creep.memory.retrieve;
  const downstreamId = creep.memory.transferTo;
  if (!upstreamId || !downstreamId) {
    recycleCreep(creep);
    return;
  }
  const upstream = Game.getObjectById(upstreamId);
  const downstream = Game.getObjectById(downstreamId);
  if (!upstream || !downstream) {
    recycleCreep(creep);
    return;
  }
  if (utils.getEnergy(creep) < 1) {
    if (retrieveEnergy(creep, upstream, true) === ERR_NOT_IN_RANGE) {
      if (!utils.isRoomSafe(upstream.pos.roomName) && creep.pos.roomName !== upstream.pos.roomName) {
        recycleCreep(creep);
      } else {
        move(creep, utils.getPosBetween(upstream.pos, downstream.pos));
      }
    }
  } else {
    const workers = creep.pos
      .findInRange(FIND_MY_CREEPS, 1)
      .filter(
        worker =>
          (worker.name.startsWith("W") || worker.name.startsWith("U")) && utils.getFillRatio(worker) < 0.5
      );
    for (const worker of workers) creep.transfer(worker, RESOURCE_ENERGY);
    if (creep.transfer(downstream, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
      if (!utils.isRoomSafe(upstream.pos.roomName) && creep.pos.roomName !== upstream.pos.roomName) {
        recycleCreep(creep);
      } else if (!followMemorizedPath(creep)) {
        const destination = utils.getPosBetween(upstream.pos, downstream.pos);
        creep.memory.path = utils.getPath(creep.pos, destination);
        followMemorizedPath(creep);
      }
    }
  }
}

function transfer(creep: Creep, destination: Creep | Structure<StructureConstant>) {
  const actionOutcome = creep.transfer(destination, RESOURCE_ENERGY);
  if (actionOutcome === OK && destination) {
    if ("memory" in destination) {
      utils.resetDestination(creep);
    }
    if (destination instanceof Creep) {
      // the receiver should reconsider what to do after getting the energy
      utils.resetDestination(destination);
    }
  }
  return actionOutcome;
}

function retrieveEnergy(creep: Creep, destination: Structure | Tombstone | Ruin | Resource, persist = false) {
  if (utils.getEnergy(destination) <= 0 && !persist) delete creep.memory.retrieve;
  if (destination instanceof Structure || destination instanceof Tombstone || destination instanceof Ruin) {
    return withdraw(creep, destination);
  } else if (destination instanceof Resource) {
    return pickup(creep, destination);
  }
  return ERR_INVALID_TARGET;
}

function handleInfantry(creep: Creep) {
  //utils.logCpu("handleInfantry(" + creep.name + ")");
  creep.notifyWhenAttacked(false);
  const flag = Game.flags.attack;
  const bestTarget = utils.getTarget(creep, undefined);
  if (!flag && !bestTarget && utils.getCreepCountByRole("infantry") > 1) {
    recycleCreep(creep);
  } else if (bestTarget) {
    if ("my" in bestTarget && bestTarget.my) {
      if (creep.heal(bestTarget) === ERR_NOT_IN_RANGE) move(creep, bestTarget);
    } else {
      const rangedAttack = creep.rangedAttack(bestTarget);
      const attack = creep.attack(bestTarget);
      if (creep.hits < creep.hitsMax) creep.heal(creep);
      if (
        rangedAttack === ERR_NOT_IN_RANGE ||
        attack === ERR_NOT_IN_RANGE ||
        bestTarget instanceof Structure
      ) {
        move(creep, bestTarget);
      } else {
        evadeHostiles(creep);
      }
    }
  } else if (flag) {
    if (utils.isStuck(creep)) {
      delete creep.memory.path; // replan
      utils.moveRandomDirection(creep);
    } else if (!followMemorizedPath(creep)) {
      creep.memory.path = utils.getPath(creep.pos, flag.pos, 0, false);
    }
  } else {
    utils.moveRandomDirection(creep);
  }
  //utils.logCpu("handleInfantry(" + creep.name + ")");
}

function evadeHostiles(creep: Creep) {
  //utils.logCpu("evadeHostiles(" + creep.name + ")");
  if (creep.room.controller?.safeMode) return;
  const hostilePositions = creep.pos
    .findInRange(FIND_HOSTILE_CREEPS, 4)
    .filter(hostile => utils.isThreatToCreep(hostile))
    .map(hostile => hostile.pos)
    .concat(creep.pos.findInRange(FIND_HOSTILE_POWER_CREEPS, 4).map(hostile => hostile.pos));
  if (hostilePositions.length < 1) return;
  const options = utils.getAccessiblePositionsAround(creep.pos, 1, 1, true);
  let bestScore = Number.NEGATIVE_INFINITY;
  let bestPos;
  const terrain = new Room.Terrain(creep.pos.roomName);
  for (const pos of options) {
    const closest = hostilePositions
      .map(value => ({
        value,
        sort: utils.getGlobalRange(pos, utils.getPos(value))
      })) /* persist sort values */
      .sort((a, b) => a.sort - b.sort) /* sort */
      .map(({ value }) => value) /* remove sort values */[0];

    const penalty = terrain.get(pos.x, pos.y) === TERRAIN_MASK_SWAMP ? 0.5 : 0;
    const score = closest ? utils.getGlobalRange(pos, closest) + penalty : Number.NEGATIVE_INFINITY;
    if (bestScore < score) {
      bestScore = score;
      bestPos = pos;
    }
  }
  if (bestPos) move(creep, bestPos);
  //utils.logCpu("evadeHostiles(" + creep.name + ")");
}

function recycleCreep(creep: Creep) {
  creep.say("♻️");
  let destination;
  const oldDestination = creep.memory.destination;
  if (typeof oldDestination === "string") destination = Game.getObjectById(oldDestination);
  if (!(destination instanceof StructureSpawn)) destination = utils.resetDestination(creep);

  if (
    !destination ||
    !(destination instanceof StructureSpawn) ||
    (creep.pos.roomName !== destination.pos.roomName && !utils.isRoomSafe(destination.pos.roomName))
  ) {
    const spawns = Object.values(Game.spawns).filter(
      spawn => creep.pos.roomName === spawn.pos.roomName || utils.isRoomSafe(spawn.pos.roomName)
    );

    destination = spawns
      .map(value => ({
        value,
        sort: utils.getGlobalRange(creep.pos, utils.getPos(value))
      })) /* persist sort values */
      .sort((a, b) => a.sort - b.sort) /* sort */
      .map(({ value }) => value) /* remove sort values */[0];

    if (destination) {
      utils.setDestination(creep, destination);
    }
  }

  if (destination) {
    if (utils.getGlobalRange(creep.pos, destination.pos) <= 1 && destination instanceof StructureSpawn) {
      if (destination.recycleCreep(creep) === OK) utils.msg(creep, "recycled!");
      return;
    } else if (!creep.memory.path) {
      creep.memory.path = utils.getPath(creep.pos, destination.pos, 1);
    }
    followMemorizedPath(creep);
  }
}

function handleHarvester(creep: Creep) {
  if (creep.spawning) return true;
  const flagName = "creep_" + creep.name;
  if (
    !creep.memory.sourceId ||
    !(flagName in Game.flags) ||
    (Game.flags[flagName].room && Game.flags[flagName].pos.findInRange(FIND_SOURCES, 1).length < 1)
  ) {
    recycleCreep(creep);
    return true;
  }
  // move
  const flag = Game.flags[flagName];
  if (!utils.isPosEqual(creep.pos, flag.pos)) move(creep, flag);
  if (!creep.memory.workStartTime && utils.getGlobalRange(creep.pos, flag.pos) <= 1)
    /* count as working, even if we have to wait for the previous harvester to die */
    creep.memory.workStartTime = Game.time;
  if (utils.getFillRatio(creep) > 0.5) harvesterSpendEnergy(creep);
  // harvest
  const sourceId = creep.memory.sourceId;
  if (sourceId) {
    const source = Game.getObjectById(sourceId);
    if (source) {
      const outcome = creep.harvest(source);
      if (outcome === ERR_NOT_OWNER) recycleCreep(creep);
    }
  }
  return true;
}

function harvesterSpendEnergy(creep: Creep) {
  if (
    creep.pos.findInRange(FIND_MY_CREEPS, 10).filter(nearbyCreep => nearbyCreep.name.startsWith("W")).length <
    1
  ) {
    const site = creep.pos.lookFor(LOOK_CONSTRUCTION_SITES)[0];
    if (site) creep.build(site);
  }
  const link = creep.pos.findInRange(FIND_MY_STRUCTURES, 1).filter(utils.isLink)[0];
  if (link) creep.transfer(link, RESOURCE_ENERGY);
}

function handleRoom(room: Room) {
  const polyPoints = room.memory.polyPoints;
  if (polyPoints) new RoomVisual(room.name).poly(polyPoints);
  handleRoomTowers(room);
  if (!room.memory.costMatrix || utils.gotSpareCpu()) {
    room.memory.costMatrix = getFreshCostMatrix(room.name).serialize();
    room.memory.costMatrixCreeps = getFreshCostMatrixCreeps(room.name).serialize();
  }
  if (Math.random() < 0.1 && utils.gotSpareCpu()) handleRoomObservers(room);
  utils.handleHostilesInRoom(room);
  if (room.controller?.my && utils.canOperateInRoom(room) && utils.gotSpareCpu())
    utils.updateRoomLayout(room);
  utils.handleLinks(room);
  if (!room.memory.score) utils.updateRoomScore(room);
  utils.checkRoomCanOperate(room);
  if (Math.random() < 0.1 && utils.gotSpareCpu()) updateStickyEnergy(room);
  spawnCarriers(room);
  spawnByQuota(room, "worker", 1);
  spawnByQuota(room, "upgrader", 1);
  spawnCreepWhenStorageFull(room);
  if (Math.random() < 0.1 && utils.gotSpareCpu()) handleRoads(room);
  updateRoomEnergy(room);
}

function handleRoads(room: Room) {
  const roads = room.find(FIND_STRUCTURES).filter(utils.isRoad);
  for (const road of roads) {
    road.notifyWhenAttacked(false);
  }
}

function spawnCarriers(room: Room) {
  const controller = room.controller;
  if (!controller || !controller.my) return;
  const carriers = Object.values(Game.creeps).filter(
    creep => creep.name.startsWith("C") && creep.memory.room === room.name
  );
  const freshCarriers = carriers.filter(creep => !creep.memory.lastTimeFull);
  if (freshCarriers.length > 0) return; //don't spawn more carriers until the existing ones have fetched a full load at least once
  const fullContainers = room
    .find(FIND_STRUCTURES)
    .filter(utils.isContainer)
    .filter(container => utils.isFull(container) && !utils.isStorageSubstitute(container)).length;
  const storage = getStorage(room);
  const energyStored = storage && utils.getEnergy(storage) > 0;
  const spawnsLacking = (room.memory.lackedEnergySinceTime ?? 0) < Game.time - 100;
  if ((fullContainers > 0 || (energyStored && spawnsLacking)) && (carriers.length < 1 || utils.gotSpareCpu()))
    spawnCreepForRoom("carrier", controller.pos);
}

function spawnByQuota(room: Room, role: Role, max: number) {
  const controller = room.controller;
  if (!controller || !controller.my) return;
  const count = Object.values(Game.creeps).filter(
    creep => creep.name.startsWith(role.charAt(0).toUpperCase()) && creep.memory.room === room.name
  ).length;
  if (count < max) spawnCreepForRoom(role, controller.pos);
}

function handleRoomTowers(room: Room) {
  const defaultRange = 50;
  if (!room.memory.towerMaxRange) room.memory.towerMaxRange = defaultRange;
  else if (room.memory.towerLastTarget && room.memory.towerLastTargetHits) {
    const lastTarget = Game.getObjectById(room.memory.towerLastTarget);
    if (lastTarget && lastTarget.hits >= room.memory.towerLastTargetHits) room.memory.towerMaxRange -= 1;
  }

  const towers = room
    .find(FIND_MY_STRUCTURES)
    .filter(utils.isTower)
    .filter(tower => utils.getEnergy(tower) > 0);
  if (towers.length < 1) return;
  if (towers.filter(tower => utils.isFull(tower)).length > 0) room.memory.towerMaxRange = defaultRange;

  let hostiles: (Creep | PowerCreep)[] = room.find(FIND_HOSTILE_CREEPS);
  Array.prototype.push.apply(hostiles, room.find(FIND_HOSTILE_POWER_CREEPS));

  let target = hostiles
    .filter(hostile => hostile.pos.findInRange(towers, room.memory.towerMaxRange ?? defaultRange).length > 0)
    .sort((a, b) => a.hits - b.hits)[0]; //weakest
  if (!target) return;

  room.memory.towerLastTarget = target.id;
  room.memory.towerLastTargetHits = target.hits;

  logTarget(room, towers, target);
  for (const tower of towers) utils.engageTarget(tower, target);
}

function logTarget(room: Room, towers: StructureTower[], target: Creep | PowerCreep) {
  console.log(
    room,
    towers.length,
    "towers targeting hostile",
    target,
    "(",
    target.hits,
    "/",
    target.hitsMax,
    "hits) within range of",
    room.memory.towerMaxRange
  );
}

function handleRoomObservers(room: Room) {
  //utils.logCpu("handleRoomObservers(" + room.name + ")");
  const observers = room.find(FIND_MY_STRUCTURES).filter(utils.isObserver);
  for (const o of observers) {
    const rooms = Object.values(Game.rooms)
      .map(value => ({ value, sort: Math.random() })) /* persist sort values */
      .sort((a, b) => a.sort - b.sort) /* sort */
      .map(({ value }) => value); /* remove sort values */
    for (const randomRoom of rooms) {
      const exits = Game.map.describeExits(randomRoom.name);
      const accessibleRoomNames = Object.values(exits)
        .map(value => ({ value, sort: Math.random() })) /* persist sort values */
        .sort((a, b) => a.sort - b.sort) /* sort */
        .map(({ value }) => value); /* remove sort values */
      for (const targetRoomName of accessibleRoomNames) {
        if (!(targetRoomName in Game.rooms)) {
          o.observeRoom(targetRoomName);
          //utils.logCpu("handleRoomObservers(" + room.name + ")");
          return;
        }
      }
    }
  }
  //utils.logCpu("handleRoomObservers(" + room.name + ")");
}

function move(creep: Creep, destination: Destination) {
  const options: MoveToOpts = {
    // bit of randomness to prevent creeps from moving the same way at same time to pass each other
    reusePath: Math.round((Memory.maxTickLimit ?? 0) - Game.cpu.tickLimit + Math.random()),
    visualizePathStyle: {
      stroke: creep.memory.stroke,
      opacity: 0.6,
      lineStyle: "dotted",
      strokeWidth: creep.memory.strokeWidth
    },
    plainCost: 2,
    swampCost: 10,
    costCallback: utils.getCachedCostMatrixCreeps
  };
  const outcome = creep.moveTo(destination, options);
  return outcome;
}

function withdraw(creep: Creep, destination: Destination) {
  if (destination instanceof Structure || destination instanceof Tombstone || destination instanceof Ruin) {
    const actionOutcome = creep.withdraw(destination, RESOURCE_ENERGY);
    return actionOutcome;
  }
  return ERR_INVALID_TARGET;
}

function pickup(creep: Creep, destination: Destination) {
  if (destination instanceof Resource) {
    const actionOutcome = creep.pickup(destination);
    return actionOutcome;
  }
  return ERR_INVALID_TARGET;
}

function spawnCreeps() {
  const budget = utils.gotSpareCpu() ? Memory.plan?.maxRoomEnergy : Memory.plan?.maxRoomEnergyCap;
  if (Memory.plan?.needTransferers) {
    spawnTransferer();
  } else if (Memory.plan?.needHarvesters) {
    spawnHarvester();
  } else if (Memory.plan?.needInfantry) {
    spawnCreep("infantry", Math.max((Memory.hostileCreepCost ?? 0) / 2, Memory.plan.maxRoomEnergy ?? 0));
  } else if (needExplorers() && utils.gotSpareCpu()) {
    spawnCreep("explorer", undefined, [MOVE]);
  } else if (Memory.plan?.needReservers && budget && budget >= utils.getBodyCost(["claim", "move"])) {
    spawnReserver();
  }
}

function needReservers() {
  return (
    (Memory.plan?.controllersToReserve?.length ?? 0) > 0 ||
    ("claim" in Game.flags && utils.getCreepCountByRole("reserver") < 1)
  );
}

function updateFlagClaim() {
  if ("claim" in Game.flags) {
    const room = Game.flags.claim.room;
    if (room && room.controller && room.controller.my) {
      utils.msg(
        Game.flags.claim,
        "Clearing 'claim' flag from room " +
          room.name +
          ". " +
          (room.controller.my ? "It's our room now!" : ""),
        true
      );
      Game.flags.claim.remove();
    }
  }
  if ("claim" in Game.flags) return;

  const myRooms = Object.values(Game.rooms).filter(room => room.controller && room.controller.my);
  if (myRooms.length >= Game.gcl.level) return;

  const bestRoomName = getRoomToClaim(myRooms);

  if (!bestRoomName) return;
  if (!(bestRoomName in Game.rooms)) return;
  const controller = Game.rooms[bestRoomName].controller;
  if (!controller) return;
  utils.msg(controller, "Flagging room " + bestRoomName + " to be claimed!", true);
  controller.pos.createFlag("claim", COLOR_WHITE, COLOR_BLUE);
}

function getRoomToClaim(aroundRooms: Room[]) {
  let bestScore = Number.NEGATIVE_INFINITY;
  let bestRoomName;

  for (const room of aroundRooms) {
    const exits = Game.map.describeExits(room.name);
    const claimableRoomNames = Object.values(exits).filter(
      roomName =>
        utils.isRoomSafe(roomName) &&
        Memory.rooms[roomName]?.canOperate &&
        utils.getRoomStatus(roomName) === utils.getRoomStatus(room.name) &&
        !aroundRooms.map(room => room.name).includes(roomName) &&
        utils.canOperateInSurroundingRooms(roomName)
    );
    for (const nearRoomName of claimableRoomNames) {
      const score = Memory.rooms[nearRoomName].score;
      if (score && bestScore < score) {
        bestScore = score;
        bestRoomName = nearRoomName;
      }
    }
  }
  return bestRoomName;
}

function needInfantry() {
  if (!("attack" in Game.flags)) return false;

  return (
    Object.values(Game.rooms)
      .filter(room => room.controller?.my)
      .reduce(
        (aggregate, room) =>
          aggregate +
          Math.max(
            0,
            room.find(FIND_HOSTILE_CREEPS).length +
              room.find(FIND_HOSTILE_POWER_CREEPS).length -
              room
                .find(FIND_MY_STRUCTURES)
                .filter(utils.isTower)
                .filter(t => utils.getEnergy(t) > 0).length
          ),
        0 /* initial*/
      ) >= utils.getCreepCountByRole("infantry")
  );
}

function spawnReserver() {
  let task: Task | undefined;
  const controllerId = Memory.plan?.controllersToReserve?.[0];
  if (!controllerId) return;
  const controller = Game.getObjectById(controllerId) || Game.flags.claim?.room?.controller;
  if (controller) {
    task = {
      destination: controller,
      action: "reserveController"
    };
  }
  const energy = Math.min(Memory.plan?.maxRoomEnergy ?? 0, 3800);
  spawnCreep("reserver", energy, undefined, task);
}

function getDestructibleWallAt(pos: RoomPosition) {
  const walls = pos.lookFor(LOOK_STRUCTURES).filter(utils.isDestructibleWall);
  if (walls.length && walls[0].destroy() === ERR_NOT_OWNER) return walls[0];
  return;
}

function updateFlagAttack() {
  //utils.logCpu("updateFlagAttack()");
  const flagAttack = Game.flags.attack;
  if (flagAttack) {
    if (
      flagAttack.room &&
      !getDestructibleWallAt(flagAttack.pos) &&
      getTargetsInRoom(flagAttack.room).length < 1
    ) {
      flagAttack.remove(); // have visibility to the room and it's clear of hostiles
    } else {
      //utils.logCpu("updateFlagAttack()");
      return; // current flag is still valid (to the best of our knowledge)
    }
  }
  // no flag, find new targets
  //utils.logCpu("updateFlagAttack() new");
  let targets: (Structure | Creep | PowerCreep)[] = [];
  for (const r in Game.rooms) {
    const controller = Game.rooms[r].controller;
    if (!controller) continue;
    if (!controller.my) continue;
    if (!utils.isReservationOk(controller)) continue;
    //utils.logCpu("updateFlagAttack() targets");
    targets = targets.concat(getTargetsInRoom(Game.rooms[r]));
    //utils.logCpu("updateFlagAttack() targets");
  }
  const target = targets[Math.floor(Math.random() * targets.length)];
  if (target) {
    target.pos.createFlag("attack", COLOR_RED, COLOR_BROWN);
    utils.msg(target, "targeted!");
  }
  //utils.logCpu("updateFlagAttack() new");
  //utils.logCpu("updateFlagAttack()");
}

function updateFlagDismantle() {
  //utils.logCpu("updateFlagDismantle()");
  const flagDismantle = Game.flags.dismantle;
  if (flagDismantle) {
    if (flagDismantle.room && flagDismantle.pos.lookFor(LOOK_STRUCTURES).length < 1) {
      flagDismantle.remove(); // have visibility to the room and it's clear of structures
    } else {
      return; // current flag is still valid (to the best of our knowledge)
    }
  }
  // no flag, find new targets
  const shuffledRoomNames = Object.keys(Game.rooms)
    .filter(utils.isRoomSafe)
    .map(value => ({ value, sort: Math.random() })) /* persist sort values */
    .sort((a, b) => a.sort - b.sort) /* sort */
    .map(({ value }) => value); /* remove sort values */
  for (const r of shuffledRoomNames) {
    if (!utils.shouldHarvestRoom(Game.rooms[r])) continue;
    if (Math.random() < 0.01) {
      const wall = getWallToDestroy(Game.rooms[r]);
      if (wall) {
        wall.pos.createFlag("dismantle", COLOR_BLUE, COLOR_BLUE);
        //utils.logCpu("updateFlagDismantle()");
        return;
      }
    }
  }
  //utils.logCpu("updateFlagDismantle()");
}

function getTargetsInRoom(room: Room) {
  let targets: (Structure | Creep | PowerCreep)[] = [];
  targets = targets.concat(room.find(FIND_HOSTILE_STRUCTURES));
  targets = targets.concat(room.find(FIND_HOSTILE_CREEPS));
  targets = targets.concat(room.find(FIND_HOSTILE_POWER_CREEPS));
  return targets;
}

function getWallToDestroy(room: Room) {
  // shorten the routes between containers and storages by destroying walls
  if (!utils.shouldHarvestRoom(room)) return;
  //utils.logCpu("getWallToDestroy(" + room.name + ")");
  const containers = room.find(FIND_STRUCTURES);
  for (const container of containers) {
    if (container.structureType !== STRUCTURE_CONTAINER) continue;
    const storages = Object.values(Game.structures);
    for (const storage of storages) {
      if (storage.structureType !== STRUCTURE_STORAGE) continue;
      const path = room.findPath(container.pos, storage.pos, {
        ignoreCreeps: true,
        ignoreDestructibleStructures: true,
        ignoreRoads: true
      });
      for (const step of path) {
        const wall = getDestructibleWallAt(new RoomPosition(step.x, step.y, room.name));
        //utils.logCpu("getWallToDestroy(" + room.name + ")");
        if (wall && wall.destroy() === ERR_NOT_OWNER) return wall;
      }
    }
  }
  //utils.logCpu("getWallToDestroy(" + room.name + ")");
  return;
}

function updateFlagReserve() {
  //utils.logCpu("updateFlagReserve()");
  const flagReserve = Game.flags.reserve;
  if (flagReserve) {
    if (flagReserve.room && !utils.shouldReserveRoom(flagReserve.room)) {
      flagReserve.remove();
    } else {
      //utils.logCpu("updateFlagReserve()");
      return; // current flag is still valid
    }
  }
  const targets = Memory.plan?.controllersToReserve?.map(id => Game.getObjectById(id));
  if (targets?.length && targets[0]) {
    targets[0].pos.createFlag("reserve", COLOR_ORANGE, COLOR_WHITE);
  }
  //utils.logCpu("updateFlagReserve()");
}

function getSourceToHarvest() {
  let sources: Source[] = [];
  for (const roomName in Game.rooms) {
    const room = Game.rooms[roomName];
    if (!utils.isRoomSafe(roomName)) continue;
    if (!utils.canOperateInRoom(room)) continue;
    if (!utils.shouldHarvestRoom(room)) continue;
    sources = sources.concat(
      room.find(FIND_SOURCES).filter(harvestSource => !utils.sourceHasHarvester(harvestSource))
    );
  }
  if (sources.length < 1) return;
  const source = sources
    .map(value => ({ value, sort: value.energy + value.energyCapacity })) /* persist sort values */
    .sort((a, b) => b.sort - a.sort) /* sort */
    .map(({ value }) => value) /* remove sort values */[0];
  return source;
}

function spawnHarvester() {
  const roleToSpawn: Role = "harvester";
  const source = getSourceToHarvest();
  if (!source || !(source instanceof Source)) return;
  let body: BodyPartConstant[] | null = utils.getBodyForHarvester(source);
  let cost = utils.getBodyCost(body);
  let spawn = getSpawn(cost, source.pos);
  while (!spawn && body) {
    body = downscaleHarvester(body);
    if (!body) return;
    cost = utils.getBodyCost(body);
    spawn = getSpawn(cost, source.pos);
  }
  if (!spawn || !body) return;
  const name = utils.getNameForCreep(roleToSpawn);
  let harvestPos = getHarvestPos(source);
  if (!harvestPos) return;
  const memory = {
    sourceId: source.id,
    stroke: utils.hslToHex(Math.random() * 360, 100, 50),
    strokeWidth: 0.1 + 0.1 * (Math.random() % 4),
    pos: spawn.pos
  };
  if (spawn.spawnCreep(body, name, { memory }) === OK) {
    utils.setDestinationFlag(name, harvestPos);
  }
  return true;
}

function spawnTransferer() {
  const roleToSpawn: Role = "transferer";
  const storages = getStoragesRequiringTransferer();
  if (storages.length < 1) return;
  const tgtStorage = storages[0];
  const link = tgtStorage.pos.findClosestByRange(FIND_MY_STRUCTURES, {
    filter: { structureType: STRUCTURE_LINK }
  });
  if (!link || !utils.isLink(link)) return;
  const body: BodyPartConstant[] = [CARRY, CARRY, CARRY, MOVE];
  const cost = utils.getBodyCost(body);
  const spawn = getSpawn(cost, tgtStorage.pos);
  if (!spawn) return;
  const name = utils.getNameForCreep(roleToSpawn);
  return (
    spawn.spawnCreep(body, name, {
      memory: getTransferrerMem(link.id, tgtStorage.id, spawn.pos)
    }) === OK
  );
}

function getTransferrerMem(retrieve: Id<StructureLink>, transferTo: Id<StructureStorage>, pos: RoomPosition) {
  return {
    retrieve,
    transferTo,
    stroke: utils.hslToHex(Math.random() * 360, 100, 50),
    strokeWidth: 0.1 + 0.1 * (Math.random() % 4),
    pos
  };
}

function getSpawn(energyRequired: number, targetPos: RoomPosition | undefined, maxRange = 100) {
  return Object.values(Game.spawns)
    .filter(spawn => spawn.room.energyAvailable >= energyRequired && !spawn.spawning)
    .filter(s => !targetPos || s.pos.roomName === targetPos?.roomName || utils.isRoomSafe(s.pos.roomName))
    .map(spawn => ({
      spawn: spawn,
      range: targetPos ? utils.getGlobalRange(spawn.pos, targetPos) : 0
    })) /* persist sort values */
    .filter(spawnRange => spawnRange.range <= maxRange)
    .sort((a, b) => a.range - b.range) /* sort */
    .map(({ spawn }) => spawn) /* remove sort values */[0];
}

function spawnCreep(
  roleToSpawn: Role,
  energyRequired?: number,
  body: undefined | BodyPartConstant[] = undefined,
  task: Task | undefined = undefined,
  upgradeTarget: StructureController | undefined = undefined,
  spawn: StructureSpawn | undefined = undefined,
  memory: CreepMemory | undefined = undefined
) {
  if (!energyRequired && body) energyRequired = utils.getBodyCost(body);
  if (!energyRequired || energyRequired < 50) return false;
  if (!body) body = getBody(roleToSpawn, energyRequired);
  const name = utils.getNameForCreep(roleToSpawn);
  if (!spawn) spawn = getSpawn(energyRequired, utils.getPos(task?.destination));
  if (!spawn) return false;
  if (spawn.spawning) return false;
  if (!body || utils.getBodyCost(body) > spawn.room.energyAvailable || !body.includes(MOVE)) return false;

  const outcome = spawn.spawnCreep(body, name, {
    memory: memory ?? getInitialCreepMem(roleToSpawn, task, spawn.pos, upgradeTarget)
  });

  if (outcome === OK) {
    return true;
  } else {
    utils.msg(spawn, "Failed to spawn creep: " + outcome.toString() + " with body " + body.toString());
    console.log("body", body, "energyAvailable", energyRequired);
    return false;
  }
}

function getInitialCreepMem(
  roleToSpawn: Role,
  task: Task | undefined,
  pos: RoomPosition,
  upgradeTarget: StructureController | undefined = undefined
) {
  return {
    action: task?.action,
    destination: task?.destination && "id" in task?.destination ? task?.destination?.id : undefined,
    pos,
    stroke: utils.hslToHex(Math.random() * 360, 100, 50),
    strokeWidth: 0.1 + 0.1 * (Math.random() % 4),
    upgrade: upgradeTarget?.id
  };
}

function getBody(roleToSpawn: Role, energyAvailable: number) {
  if (roleToSpawn === "carrier") return getBodyForCarrier(energyAvailable);
  else if (roleToSpawn === "infantry") return getBodyForInfantry(energyAvailable);
  else if (roleToSpawn === "reserver") return getBodyForReserver(energyAvailable);
  else if (roleToSpawn === "upgrader") return getBodyForUpgrader(energyAvailable);
  else if (roleToSpawn === "worker") return getBodyForWorker(energyAvailable);
  return;
}

function getBodyForUpgrader(energyAvailable: number) {
  const body: BodyPartConstant[] = [WORK, CARRY, MOVE];
  for (;;) {
    let nextPart: BodyPartConstant = WORK;
    if (utils.getBodyPartRatio(body, MOVE) <= 0.2) nextPart = MOVE;
    else if (utils.getBodyPartRatio(body, CARRY) <= 0.1) nextPart = CARRY;

    if (utils.getBodyCost(body) + BODYPART_COST[nextPart] > energyAvailable) return body;
    body.push(nextPart);
    if (body.length >= 50) return body;
  }
}

function getBodyForWorker(energyAvailable: number) {
  const body: BodyPartConstant[] = [WORK, CARRY, MOVE];
  for (;;) {
    let nextPart: BodyPartConstant = WORK;
    if (utils.getBodyPartRatio(body, MOVE) <= 0.34) nextPart = MOVE;
    else if (utils.getBodyPartRatio(body, CARRY) <= 0.4) nextPart = CARRY;

    if (utils.getBodyCost(body) + BODYPART_COST[nextPart] > energyAvailable) return body;
    body.push(nextPart);
    if (body.length >= 50) return body;
  }
}

function getBodyForCarrier(energyAvailable: number) {
  const body: BodyPartConstant[] = [CARRY, MOVE];
  for (;;) {
    const nextPart = utils.getBodyPartRatio(body) <= 0.34 ? MOVE : CARRY;
    if (utils.getBodyCost(body) + BODYPART_COST[nextPart] > energyAvailable) return body;
    body.push(nextPart);
    if (body.length >= 50) return body;
  }
}

function getBodyForReserver(energyAvailable: number) {
  const body: BodyPartConstant[] = [CLAIM, MOVE];
  for (;;) {
    const nextPart = utils.getBodyPartRatio(body) <= 0.34 ? MOVE : CLAIM;
    if (utils.getBodyCost(body) + BODYPART_COST[nextPart] > energyAvailable) return body;
    body.push(nextPart);
    if (body.length >= 50) return body;
  }
}

function getBodyForInfantry(energyAvailable: number) {
  const body: BodyPartConstant[] = [
    ...Array<BodyPartConstant>(20).fill(MOVE),
    ...Array<BodyPartConstant>(10).fill(ATTACK),
    ...Array<BodyPartConstant>(10).fill(RANGED_ATTACK),
    ...Array<BodyPartConstant>(5).fill(MOVE),
    ...Array<BodyPartConstant>(5).fill(HEAL)
  ];
  while (utils.getBodyCost(body) > energyAvailable) {
    const randomIndex = Math.floor(Math.random() * body.length);
    body.splice(randomIndex, 1);
  }
  if (!body.includes(MOVE)) return;
  if (!body.includes(ATTACK) && !body.includes(RANGED_ATTACK)) return;
  return body;
}

function purgeFlagsMemory() {
  for (const key in Memory.flags) {
    if (!Game.flags[key]) delete Memory.flags[key];
  }
}

function purgeFlags() {
  for (const flag of Object.values(Game.flags)) {
    const name = flag.name;
    if (name.startsWith("traffic_")) flag.remove();
    if (name.startsWith("creep_") && !(name.substring(6) in Game.creeps)) flag.remove();
  }
}

function getStorage(room: Room): StructureContainer | StructureStorage | undefined | null {
  return (
    room.storage ??
    room.controller?.pos
      .findInRange(FIND_STRUCTURES, 2)
      .filter(utils.isStorageSubstitute)
      .filter(utils.isContainer)[0]
  );
}

function getClusterStructures(clusterPos: RoomPosition) {
  const room = Game.rooms[clusterPos.roomName];
  if (!room) return [];
  const structures = clusterPos
    .findInRange(FIND_MY_STRUCTURES, 1)
    .map(value => ({
      value,
      sort: Math.random()
    })) /* persist sort values */
    .sort((a, b) => a.sort - b.sort) /* sort */
    .map(({ value }) => value) /* remove sort values */
    .filter(utils.isOwnedStoreStructure)
    .filter(
      /* only fill storage/link when spawns/extensions are full */
      s =>
        (!utils.isStorage(s) && !utils.isStorageSubstitute(s) && !utils.isLink(s)) ||
        room.energyAvailable >= room.energyCapacityAvailable
    );
  return structures;
}

function getCarrierEnergySource(creep: Creep, minEnergy: number) {
  const room = getCreepTargetRoom(creep);
  if (!room) return;
  return getCarrierEnergySources(room)
    .filter(source => utils.getEnergy(source) >= minEnergy)
    .map(source => ({
      value: source,
      sort: utils.getGlobalRange(creep.pos, source.pos)
    })) /* persist sort values */
    .sort((a, b) => a.sort - b.sort) /* sort */
    .map(({ value }) => value) /* remove sort values */[0];
}

function getFreshCostMatrix(roomName: string) {
  const room = Game.rooms[roomName];
  const costs = new PathFinder.CostMatrix();
  if (room) {
    room.find(FIND_CONSTRUCTION_SITES).forEach(function (struct) {
      // consider construction sites as complete structures
      // same structure types block or don't block movement as complete buildings
      // incomplete roads don't give the speed bonus, but we should still prefer them to avoid planning for additional roads
      const cost = getStructurePathCost(struct);
      // correctly handle blocking structure and unfinished road in the same coords
      if (cost && cost > costs.get(struct.pos.x, struct.pos.y)) costs.set(struct.pos.x, struct.pos.y, cost);
    });
    room.find(FIND_STRUCTURES).forEach(function (struct) {
      const cost = getStructurePathCost(struct);
      if (cost && cost > costs.get(struct.pos.x, struct.pos.y)) costs.set(struct.pos.x, struct.pos.y, cost);
    });
    room.find(FIND_SOURCES).forEach(function (source) {
      // avoid routing around sources
      const positions = utils.getAccessiblePositionsAround(source.pos, 1, 1, true);
      for (const pos of positions) {
        if (costs.get(pos.x, pos.y) < 20) costs.set(pos.x, pos.y, 20);
      }
    });
  }
  return costs;
}

function getFreshCostMatrixCreeps(roomName: string) {
  const room = Game.rooms[roomName];
  const costs = new PathFinder.CostMatrix();
  if (room) {
    room.find(FIND_CONSTRUCTION_SITES).forEach(function (struct) {
      // consider construction sites as complete structures
      // same structure types block or don't block movement as complete buildings
      // incomplete roads don't give the speed bonus, but we should still prefer them to avoid planning for additional roads
      const cost = getStructurePathCost(struct);
      // correctly handle blocking structure and unfinished road in the same coords
      if (cost && cost > costs.get(struct.pos.x, struct.pos.y)) costs.set(struct.pos.x, struct.pos.y, cost);
    });
    room.find(FIND_STRUCTURES).forEach(function (struct) {
      const cost = getStructurePathCost(struct);
      if (cost && cost > costs.get(struct.pos.x, struct.pos.y)) costs.set(struct.pos.x, struct.pos.y, cost);
    });
    room.find(FIND_CREEPS).forEach(function (creep) {
      const lastMoveTime = creep.memory?.lastMoveTime;
      const cost = lastMoveTime ? Game.time - lastMoveTime : 5;
      if (cost && cost > costs.get(creep.pos.x, creep.pos.y)) costs.set(creep.pos.x, creep.pos.y, cost);
    });
  }
  return costs;
}

function updateStickyEnergy(room: Room) {
  const containers = room.find(FIND_STRUCTURES).filter(utils.isStoreStructure);
  const values: Record<Id<AnyStoreStructure>, number> = {};
  const deltas: Record<Id<AnyStoreStructure>, number> = {};
  const rate = 20; // max change per tick
  for (const container of containers) {
    const now = utils.getEnergy(container);
    const then = room.memory.stickyEnergy?.[container.id] || 0;
    values[container.id] = Math.max(Math.min(now, then + rate), then - rate);
    deltas[container.id] = now - then;
  }
  room.memory.stickyEnergy = values;
  room.memory.stickyEnergyDelta = deltas;
}

function checkWipeOut() {
  const haveCreeps = Object.keys(Game.creeps).length > 0;
  const haveSpawns = Object.keys(Game.spawns).length > 0;
  const ownedRoomCount = Object.values(Game.rooms).filter(room => room.controller?.my).length;

  if (
    (Memory.haveCreeps ?? false) !== haveCreeps ||
    (Memory.haveSpawns ?? false) !== haveSpawns ||
    (Memory.ownedRoomCount ?? 0) !== ownedRoomCount
  ) {
    utils.msg(
      "checkWipeOut()",
      "haveCreeps: " +
        haveCreeps.toString() +
        ", haveSpawns: " +
        haveSpawns.toString() +
        ", ownedRoomCount: " +
        ownedRoomCount.toString(),
      true
    );
    Memory.haveCreeps = haveCreeps;
    Memory.haveSpawns = haveSpawns;
    Memory.ownedRoomCount = ownedRoomCount;
  }
}

function downscaleHarvester(body: BodyPartConstant[]): BodyPartConstant[] | null {
  if (body.filter(part => part === "move").length > 1) {
    body.splice(body.indexOf("move"), 1);
    return body;
  } else if (body.filter(part => part === "work").length > 1) {
    body.splice(body.indexOf("work"), 1);
    return body;
  } else {
    return null;
  }
}

function getStructurePathCost(struct: AnyStructure | ConstructionSite) {
  if (struct.structureType === STRUCTURE_ROAD) {
    // Favor roads over plain tiles
    return 1;
  } else if (
    struct.structureType !== STRUCTURE_CONTAINER &&
    (struct.structureType !== STRUCTURE_RAMPART || !struct.my)
  ) {
    // Can't walk through non-walkable buildings
    return 0xff;
  }
  return null;
}

function getStructureToFillHere(pos: RoomPosition) {
  //utils.logCpu("getStructureToFillHere(" + pos.toString() + ")");
  const structures: AnyStructure[] = getClusterStructures(pos);
  for (const tgt of structures) {
    //utils.logCpu("getStructureToFillHere(" + pos.toString() + ")");
    if (!utils.isFull(tgt)) return tgt;
  }
  const room = Game.rooms[pos.roomName];
  if (room && room.energyAvailable >= room.energyCapacityAvailable) {
    const storage = getStorage(room);
    if (storage && pos.getRangeTo(storage.pos) < 2 && !utils.isFull(storage)) {
      //utils.logCpu("getStructureToFillHere(" + pos.toString() + ")");
      return storage;
    }
  }
  //utils.logCpu("getStructureToFillHere(" + pos.toString() + ")");
  return null;
}

function getStructureToFill(pos: RoomPosition) {
  const room = Game.rooms[pos.roomName];
  if (!room) return;
  const spawnMaxed = room.energyAvailable >= room.energyCapacityAvailable;
  let targets: AnyStructure[] = room
    .find(FIND_MY_STRUCTURES)
    .filter(utils.isStoreStructure)
    .filter(s => !utils.isFull(s) && !utils.isStorage(s))
    .filter(s => spawnMaxed || !utils.isLink(s));
  if (spawnMaxed) {
    const storage = getStorage(room);
    if (storage && !utils.isFull(storage)) targets.push(storage);
  }
  const randomIndex = Math.floor(Math.random() * targets.length);
  return targets[randomIndex]; //random target to reduce traffic jams
}

function getNearbyEnergySource(pos: RoomPosition, minEnergy: number) {
  let sources: (Resource | AnyStoreStructure | Tombstone | Ruin)[] = pos
    .findInRange(FIND_DROPPED_RESOURCES, 1)
    .filter(container => utils.getEnergy(container) >= minEnergy);
  sources = sources.concat(
    pos
      .findInRange(FIND_STRUCTURES, 1)
      .filter(utils.isContainer)
      .filter(container => !utils.isStorageSubstitute(container))
      .filter(container => utils.getEnergy(container) >= minEnergy)
  );
  sources = sources.concat(
    pos.findInRange(FIND_TOMBSTONES, 1, {
      filter(object) {
        return utils.getEnergy(object) >= minEnergy;
      }
    })
  );
  sources = sources.concat(
    pos.findInRange(FIND_RUINS, 1, {
      filter(object) {
        return utils.getEnergy(object) >= minEnergy;
      }
    })
  );
  if (sources.length > 0) return sources[Math.floor(Math.random() * sources.length)];

  const room = Game.rooms[pos.roomName];
  if (!room) return;
  if (room.energyAvailable < room.energyCapacityAvailable) {
    const source = pos
      .findInRange(FIND_STRUCTURES, 1)
      .filter(utils.isStoreStructure)
      .filter(s => utils.isContainer(s) || utils.isStorage(s) || utils.isLink(s))
      .filter(container => utils.getEnergy(container) > 0)[0];
    if (source) return source;
  }
  return;
}

function getPosNear(pos: RoomPosition, target: RoomPosition) {
  if (!utils.blockedByStructure(target)) return target;

  const cluster = target.findInRange(FIND_FLAGS, 1).filter(flag => flag.name.startsWith("cluster_"))[0];
  if (cluster) return cluster.pos;

  let positionsAroundTgt = utils.getSurroundingPlains(target, 1, 1, false);
  if (positionsAroundTgt.length < 1) positionsAroundTgt = utils.getSurroundingPlains(target, 1, 1, true);
  if (positionsAroundTgt.length < 1) return;

  return positionsAroundTgt
    .map(value => ({
      value,
      sort: utils.getGlobalRange(pos, utils.getPos(value))
    })) /* persist sort values */
    .sort((a, b) => a.sort - b.sort) /* sort */
    .map(({ value }) => value) /* remove sort values */[0];
}

function followMemorizedPath(creep: Creep) {
  const memPath = creep.memory.path;
  if (!memPath) return;
  const path = memPath.map(pos => new RoomPosition(pos.x, pos.y, pos.roomName));
  const outcome = creep.moveByPath(path);
  if (outcome === ERR_NOT_FOUND) {
    const end = path[path.length - 1];
    if (utils.isPosEqual(creep.pos, end)) {
      delete creep.memory.path;
      return;
    } else {
      const tgt = creep.pos.findClosestByRange(path);
      if (!tgt) return;
      move(creep, tgt);
    }
  } else if (outcome === OK) {
    if (utils.isStuck(creep)) {
      delete creep.memory.path; // replan
      utils.moveRandomDirection(creep);
    } else {
      return true;
    }
  }
  return;
}

function spawnCreepForRoom(roleToSpawn: Role, targetPos: RoomPosition) {
  const spawn = getSpawn(0, targetPos);
  if (!spawn) return false;

  const memory = {
    pos: spawn.pos,
    stroke: utils.hslToHex(Math.random() * 360, 100, 50),
    strokeWidth: 0.1 + 0.1 * (Math.random() % 4),
    room: targetPos.roomName
  };
  return spawnCreep(roleToSpawn, spawn.room.energyAvailable, undefined, undefined, undefined, spawn, memory);
}

function getCarrierEnergySources(
  room: Room
): (Resource<ResourceConstant> | Tombstone | AnyStoreStructure | Ruin)[] {
  let containers: (AnyStoreStructure | Resource | Tombstone | Ruin)[] = [];
  containers = containers
    .concat(
      room
        .find(FIND_STRUCTURES)
        .filter(utils.isContainer)
        .filter(container => !utils.isStorageSubstitute(container))
        .filter(container => utils.getEnergy(container) > 0)
    )
    .concat(room.find(FIND_DROPPED_RESOURCES))
    .concat(room.find(FIND_TOMBSTONES).filter(container => utils.getEnergy(container) > 0))
    .concat(room.find(FIND_RUINS).filter(container => utils.getEnergy(container) > 0));
  if (room.energyAvailable < room.energyCapacityAvailable) {
    containers = containers.concat(
      room
        .find(FIND_STRUCTURES)
        .filter(utils.isStoreStructure)
        .filter(s => utils.isContainer(s) || utils.isStorage(s) || utils.isLink(s))
        .filter(container => utils.getEnergy(container) > 0)
    );
  }
  return containers;
}

function getStoragesRequiringTransferer() {
  return Object.values(Game.structures)
    .filter(utils.isStorage)
    .filter(
      storage =>
        utils.hasStructureInRange(storage.pos, STRUCTURE_LINK, 2, false) &&
        Object.values(Game.creeps).filter(
          creep =>
            creep.name.startsWith("T") &&
            creep.memory.transferTo === storage.id &&
            (creep.ticksToLive || 100) > 30
        ).length <= 0
    );
}

function getBuildSitePriority(site: ConstructionSite<BuildableStructureConstant>) {
  const prioritizedTypes = [
    STRUCTURE_SPAWN,
    STRUCTURE_TOWER,
    STRUCTURE_STORAGE,
    STRUCTURE_CONTAINER,
    STRUCTURE_EXTENSION,
    STRUCTURE_ROAD,
    STRUCTURE_LINK,
    STRUCTURE_WALL,
    STRUCTURE_RAMPART,
    STRUCTURE_EXTRACTOR,
    STRUCTURE_OBSERVER,
    STRUCTURE_POWER_SPAWN,
    STRUCTURE_LAB,
    STRUCTURE_TERMINAL,
    STRUCTURE_NUKER,
    STRUCTURE_FACTORY
  ];
  const index = prioritizedTypes.indexOf(site.structureType);
  return index < 0 ? 100 : index + 1;
}

function getSignText(): string {
  // The sign text. The string is cut off after 100 characters.
  let texts = [
    '"Mushroom, mushroom," shut, it! Get back to work!',
    "A warrior from afar, are you? May you enjoy victory in battle. Umbasa.",
    "Ah, we meet again. Fancy that. Hope you find something that suits you.",
    "All done? Then be gone. I work alone.",
    "Are you begging for a magic lesson?",
    "Are you here to face the Demons?",
    "Are you here to fight the Demons?",
    "Art thou done? May thine strength help the world be mended.",
    "Assignment complete! Er, oh, no, wait, my bad... There's still one mission to go. Apologies.",
    "Be you brave knight or depraved slave, the Demons will snatch your soul, then you'll go mad.",
    "Brave soul, who fears not death. Prithee, lull the Old One back to its ancient slumber.",
    "Brave souls, who fears not death. I shall guide you to the Nexus.",
    "By the Beard!",
    "Come on guys! Rock and Stone!",
    "Did I hear a Rock and Stone?",
    "Did you ever visit the Valley of Defilement?",
    "Do come back alive. I need your business.",
    "Do keep in mind that using firearms for anything besides combat is strictly against regulations.",
    "Do you seek the power of God?",
    "Don't you just walk away!",
    "Eh, it's not good, it doesn't look good",
    "Enough about the mushrooms! We all know it's a mushroom! We get it!",
    "For Karl!",
    "For Rock and Stone!",
    "For Teamwork!",
    "For the love of God… I've had enough humiliation for one lifetime.",
    "For those about to Rock and Stone, we salute you!",
    "Galaxies finest!",
    "Gimmie a Rock... and Stone!",
    "Gimmie an R! Gimmie an S! Gimmie a Rock. And. Stone!",
    "Go ahead, take your time. I'm not going anywhere. Heh heh heh.",
    "God bless this brave warrior. Umbasa.",
    "God has chosen you, and for that we are thankful. Umbasa.",
    "Going to just give up? That's what I did. I think I just lost my nerve for this kind of thing…",
    "Hahahah, you've gone and died, have you?",
    "Hard times, eh? I'm sure you'll turn things around. Heh heh heh.",
    "Has God abandoned us for failing to show proper respect to King Allant? Oh, umbasa…",
    "Have you heard? If you are attacked by a Demon, you will lose your humanity. What a horrible thought",
    "Have you the strength to accept this mission?",
    "Heh heh heh. C'mon, let's be friends, what do you say! No need to drag each other down.",
    "Hello again. I'm keeping a close watch on your belongings. Rest assured.",
    "Help! Helppp! Soul-starved soldiers are after me!",
    "Hm? I haven't seen you around these parts. Bah, what does it matter?",
    "Hold it friend! Going so soon?",
    "How do you do it? I can't imagine what it takes to slay a Demon…If only I could assist in this fight",
    "I am not done yet.",
    "I can see, that you have killed in the past… No one can blame you for that.",
    "I can't control it, we're going down!",
    "I find something odd about this place. It brims with grime, but at once feels strangely pure.",
    "I have always been here in this Nexus.",
    "I have no business with your kind. I'm busy, begone with you!",
    "I keep the candles lit and serve the brave Demon slayers who are trapped here.",
    "I see. You wish to train yourself in stoicism. Very well. I pray we meet again.",
    "I shall lull the Old One back to slumber.",
    "I was here when the Old One awakened, and I will be here when It rests once again.",
    "I wish I could do more, but I am ignorant of the world beyond these walls.",
    "I, too, am on a quest to fight the Demons in the name of the Lord.",
    "I, too, must contribute how I can, for we are indebted to our honorable defenders.",
    "I'm not afraid! I'll tear you limb from limb!",
    "I'm sorry. I cannot die. Not while the Nexus binds me…",
    "If I had a credit for every Rock and Stone.",
    "If only my real job was as easy as playing a video game...",
    "If you die here in Boletaria, your soul is returned to the Nexus. Well, what'll you do next?",
    "If you don't Rock and Stone, you ain't comin' home!",
    "If you Rock and Stone, you're never alone!",
    "Is there a single sane person left in Boletaria?",
    "It is the end of Great Boletaria as we know it.",
    "Last one to Rock and Stone pays for the first round!",
    "Leave No Dwarf Behind!",
    "Let strength be granted, so the world might be mended... So the world might be mended.",
    "Let's not have a repeat of the flamethrower incident in the mess hall...",
    "Let's Rock and Stone!",
    "Like that! Rock and Stone!",
    "May I share God's power with you? Do not be bashful; we are both cut from the same cloth.",
    "May the heavens gaze favorably upon you. Umbasa.",
    "May-May-Ma-Mayday-Mayday",
    "Mother control, I can't, I can't control it",
    "My old Mother would be proud indeed! Aren't you proud of me too?",
    "No matter how far I venture, only the soul starved remain.",
    "None can stand before us!",
    "Not good, this is not good!",
    "O Lord, punish me. For I have not the strength to punish myself.",
    "Oh, fellow disciple, you seek the power of God?",
    "Oh, I can hardly believe it! The fact that I am helping to save the world! Oh, Saint Urbain…Umbasa.",
    "Oh, is that you again? Do you have further gifts to offer?",
    "Oh, it's you. Did you cleanse the world of another dark soul today?",
    "Oh, my, how has this happened?",
    "Oh! the Demons haven't got to you, have they?",
    "R&D asked me to remind you never to look directly at the beam while firing.",
    "Rock and roll and stone!",
    "Rock and roll!",
    "Rock and Stone everyone!",
    "Rock and Stone forever!",
    "Rock and Stone in the Heart!",
    "Rock and Stone like there's no tomorrow!",
    "Rock and Stone to the Bone!",
    "Rock and Stone you beautiful dwarf!",
    "Rock and Stone, Brother!",
    "Rock and Stone, the pretty sound of teamwork!",
    "Rock and Stone! It never gets old.",
    "Rock and Stone!",
    "Rock and Stone... Yeeaaahhh!",
    "Rock and Stone.",
    "Rock and... Stone!",
    "Rock me like a Stone!",
    "Rock on!",
    "Rock solid!",
    "Rock! (burp) And! (burp) Stone! (burp)",
    "ROCK! AND! STONE!",
    "ROCK... AND... STONE!",
    "Rock... Solid!",
    "Rockitty Rock and Stone!",
    "Soul of the lost, withdrawn from its vessel. Let strength be granted so the world might be mended.",
    "Soul of the mind, key to life's ether. Soul of the lost, withdrawn from its vessel.",
    "Stay the path, and you will soon be a monster yourself! Hahahahahah!",
    "Still alive? I am impressed.",
    "Stone and Rock! ...Oh, wait...",
    "Stone.",
    "Thank goodness you are safe! I was worried sick about you.",
    "That's it lads! Rock and Stone!",
    "The King? He's gone mad like the rest of them. Or perhaps he was mad in the first place.",
    "The Old One and I shall slumber interminably. That is the way it must be.",
    "The Old One, without Demons to feed it souls, will a new servant seek, and lure you to its bosom.",
    "There are no secrets here; only a tired, emaciated frame.",
    "This is bad… Not a single person left… Why on Earth? How did all of this happen… Father!",
    "This place is buzzing with pests fattened on a diet of souls.",
    "This place? It's a proper mound of rubbish. All the rot of the world, living or not, ends up here.",
    "Thou seeketh soul power, dost thou not? Then touch the Demon inside me.",
    "Tick tock, team! We're not getting any younger down here!",
    "We are indebted to you, for you fight on our behalf.",
    "We are unbreakable!",
    "We fight for Rock and Stone!",
    "We have long await'd you, slayer of Demons.",
    "We rock!",
    "We're the best!",
    "We're welcome here as long as we keep slashing up Demons. Hahahahah…",
    "WE'RE RICH!",
    "Well, do as you please, but don't come a-crying when it works not.",
    "Well, well… Very smooth work. Almost… merciless.",
    "Well, what have we here? Do you wish to die so soon?",
    "Well, you slipped through the fissure too, did you? You came for Demon Souls?",
    "Well, you’ve found yourself a Demon’s Soul, have you? I’m impressed… yes, indeed I am.",
    "What a terrible nightmare! I dreamt I worked for a soulless mining corporation. Wait... aw, crap.",
    "What are you doing? Have the souls driven you mad?",
    "What do you want, brute? I have no use for miscreants like yourself. Away with you!",
    "What is it? Dost thou seek soul power?",
    "What is the world like outside the Nexus?",
    "What’s happened, Have you lost your nerve? No matter. Have a seat; we can sit here forever!",
    "What's the hurry? Where're you off to? Haven't ye any manners?",
    "Whoa... I know everything about everything! Ask me something, quick! Wait! Oh—it passed.",
    "Ye covetous one, let it be known, we shall defend our heart and home to the death.",
    "Yeaahhh! Rock and Stone!",
    "Yeah, yeah, Rock and Stone.",
    "Yer want to play, well, you've got to pay. Don't you agree?",
    "Yes, we are fortunate indeed to have you. Now, go forth, and destroy every last Demon.",
    "You came for Demon Souls? Or to save this land, and be remembered as a Hero?",
    "You don't deserve to die, so let me give you some advice.",
    "You have a heart of gold. Don't let them take it from you.",
    "You may be a great Demon hunter, but I fear you may not be ready.",
    "You must lull the Old One back to Its slumber, and seal it away for all eternity.",
    "You there…I can sense it. You can hear the voice of God. And you are battling those terrible Demons.",
    "You're simply unlucky. Worry not. Stay by me, and my luck'll rub off on you soon enough!"
  ];
  if (Memory.signTexts) texts = texts.concat(Memory.signTexts);
  const randomIndex = Math.floor(Math.random() * texts.length);
  return texts[randomIndex];
}

function getHarvestPos(source: Source) {
  const positions = utils.getPositionsAroundWithTerrainSpace(source.pos, 1, 1, 1, 1);
  return (
    positions.find(
      /*container here*/
      pos => pos.lookFor(LOOK_FLAGS).filter(f => f.name.startsWith(STRUCTURE_CONTAINER + "_")).length > 0
    ) ??
    positions.find(
      /*next to link*/
      pos => pos.findInRange(FIND_FLAGS, 1).filter(f => f.name.startsWith(STRUCTURE_LINK + "_")).length > 0
    ) ??
    positions[0] /*space around*/
  );
}

function spawnCreepWhenStorageFull(room: Room) {
  const controller = room.controller;
  if (!controller || !controller.my) return;
  if (room.energyAvailable < room.energyCapacityAvailable) return;
  const storage = getStorage(room);
  if (!storage || !utils.isFull(storage)) return;
  const workers = Object.values(Game.creeps).filter(
    creep => creep.name.startsWith("W") && creep.memory.room === room.name
  ).length;
  const upgraders = Object.values(Game.creeps).filter(
    creep => creep.name.startsWith("U") && creep.memory.room === room.name
  ).length;
  if (workers + Math.random() < upgraders + Math.random()) spawnCreepForRoom("worker", controller.pos);
  else spawnCreepForRoom("upgrader", controller.pos);
}

function getUpgraderSpot(room: any) {
  const storage = getStorage(room);
  if (!storage) return;
  return utils
    .getSurroundingPlains(storage.pos, 0, 1, true)
    .map(pos => ({ pos, sort: pos.look().length + Math.random() })) /* persist sort values */
    .sort((a, b) => a.sort - b.sort) /* sort */
    .map(({ pos }) => pos)[0]; /* remove sort values */
}

function updateRoomEnergy(room: Room): void {
  const oldRatio = room.memory.energyRatio || 0;
  room.memory.energyRatio = room.energyAvailable / room.energyCapacityAvailable;
  room.memory.energyRatioDelta = room.memory.energyRatio - oldRatio;
  if (room.memory.energyRatioDelta > 0.004 || room.memory.energyRatio >= 1)
    room.memory.lackedEnergySinceTime = Game.time;
}

function repairLocal(creep: Creep) {
  const repairTarget = creep.pos
    .findInRange(FIND_STRUCTURES, 3)
    .filter(
      s =>
        s.hits < s.hitsMax &&
        s.hits <
          (s.room.memory.maxHitsToRepair ?? Number.POSITIVE_INFINITY) /* repair ramparts & stuff evenly */
    )
    .map(target => ({
      target,
      sort: target.hits
    })) /* persist sort values */
    .sort((a, b) => a.sort - b.sort) /* sort */
    .map(({ target }) => target) /* remove sort values */[0];

  if (!repairTarget) return false;
  creep.repair(repairTarget);
  return true;
}

function repairRoom(creep: Creep) {
  const room = getCreepTargetRoom(creep);
  if (!room) return false;
  const repairTarget = room
    .find(FIND_STRUCTURES)
    .filter(s => s.hits <= s.hitsMax - 300 || s.hits <= s.hitsMax / 2) /* damage worth moving to */
    .map(target => ({
      target,
      sort: target.hits
    })) /* persist sort values */
    .sort((a, b) => a.sort - b.sort) /* sort */
    .map(({ target }) => target) /* remove sort values */[0];

  if (!repairTarget) return false;
  room.memory.maxHitsToRepair = repairTarget.hits + 5000; /* repair ramparts & stuff evenly */
  if (creep.repair(repairTarget) === ERR_NOT_IN_RANGE) move(creep, repairTarget);
  return true;
}

function workerRetrieveEnergy(creep: Creep) {
  if (
    creep.room.storage &&
    utils.getEnergy(creep.room.storage) > 0 &&
    retrieveEnergy(creep, creep.room.storage) === ERR_NOT_IN_RANGE
  ) {
    move(creep, creep.room.storage);
  } else {
    const container = creep.pos.findClosestByRange(FIND_STRUCTURES, {
      filter(object) {
        return utils.isContainer(object) && utils.getEnergy(object) > 0;
      }
    });
    if (container) {
      if (retrieveEnergy(creep, container) === ERR_NOT_IN_RANGE) move(creep, container);
    } else {
      const resource = creep.pos.findClosestByRange(FIND_DROPPED_RESOURCES);
      if (resource && retrieveEnergy(creep, resource) === ERR_NOT_IN_RANGE) move(creep, resource);
    }
  }
}
