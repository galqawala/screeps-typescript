// Memory.printCpuInfo=true;

// When compiling TS to JS and bundling with rollup, the line numbers and file names in error messages change
// This utility uses source maps to get the line numbers and file names of the original, TS source code

import * as spawnLogic from "spawnLogic";
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
    maxTickLimit?: number;
    ownedRoomCount?: number;
    plan?: Plan;
    printCpuInfo?: boolean;
    signTexts?: string[];
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
    controllerProgress?: number;
    controllerProgressTime?: number;
    costMatrix?: number[];
    costMatrixCreeps?: number[];
    costMatrixLayout?: number[];
    costMatrixRamparts?: number[];
    energyRatio?: number;
    energyRatioDelta?: number;
    lackedEnergySinceTime?: number;
    maxHitsToRepair?: number /* repair ramparts & stuff evenly */;
    polyPoints?: RoomPosition[] /* visualize paths for debugging etc. */;
    repairPos?: RoomPosition;
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
    say?: string[];
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
  for (const room of rooms) handleRoom(room); // handle rooms in random order to give each a fair change of gotSpareCpu()
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
    removeConstructionSitesInRoomsWithoutVisibility();
  }
  if (!Memory.username) utils.setUsername();
  checkWipeOut();
  if (Math.random() < 0.1 || utils.gotSpareCpu()) updatePlan();
  spawnLogic.spawnCreeps();
  updateFlagAttack();
  updateFlagClaim();
  updateFlagReserve();
  if (utils.gotSpareCpu()) updateFlagDismantle();
  handleCreeps();
  Memory.cpuUsedRatio = Game.cpu.getUsed() / Game.cpu.limit;
  utils.logCpu("main");
  utils.cpuInfo(); // after everything!
});

function updatePlan() {
  Memory.plan = {
    controllersToReserve: utils.getControllersToReserve().map(controller => controller.id),
    needHarvesters: spawnLogic.getSourceToHarvest() ? true : false,
    needInfantry: spawnLogic.needInfantry(),
    needReservers: spawnLogic.needReservers(),
    needTransferers: spawnLogic.getStoragesRequiringTransferer().length > 0,
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

function handleCreeps() {
  utils.logCpu("handleCreeps()");
  for (const creep of Object.values(Game.creeps)) {
    utils.logCpu("creep: " + creep.name);
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
      creepTalk(creep);
    } else if (!creep.memory.spawnStartTime) {
      creep.memory.spawnStartTime = Game.time;
    }
    utils.logCpu("creep: " + creep.name);
  }
  utils.logCpu("handleCreeps()");
}

function handleExplorer(creep: Creep) {
  if (isStuck(creep)) {
    delete creep.memory.path;
    delete creep.memory.destination;
    moveRandomDirection(creep);
    return;
  }
  creep.notifyWhenAttacked(false);
  const controller = creep.room.controller;
  if (controller && (controller.sign?.username ?? "") !== Memory.username) {
    const outcome = creep.signController(controller, getRandomCoolText());
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
  const room = getAssignedRoom(creep);
  if (!room) return;
  const controller = room.controller;
  if (!controller) return;

  if (Math.random() < 0.1 && creep.pos.lookFor(LOOK_STRUCTURES).length > 0) {
    move(creep, getUpgraderSpot(room) ?? controller.pos); // stay out of roads and stuff
    return;
  }

  if (utils.getEnergy(creep) < 1) {
    const storage = utils.getStorage(room);
    if (!storage) return;
    const withdrawOutcome = creep.withdraw(storage, RESOURCE_ENERGY);
    if (withdrawOutcome === ERR_NOT_IN_RANGE) move(creep, getUpgraderSpot(room) ?? storage.pos);
  } else {
    const outcome = creep.upgradeController(controller);
    if (outcome === ERR_NOT_IN_RANGE) move(creep, getUpgraderSpot(room) ?? controller.pos);
  }
}

function handleWorker(creep: Creep) {
  const full = utils.isFull(creep);
  if (utils.getEnergy(creep) < 1) delete creep.memory.build;
  else if (full) delete creep.memory.retrieve;

  if (utils.getEnergy(creep) < 1) {
    workerRetrieveEnergy(creep);
    return;
  } else if (!full) {
    const energy = creep.pos
      .findInRange(FIND_STRUCTURES, 1)
      .filter(s => utils.isStorage(s) || (utils.isContainer(s) && utils.getEnergy(s) > 0))[0];
    if (energy) retrieveEnergy(creep, energy);
  }
  return (
    repairLocal(creep) ||
    repairRoom(creep, false) ||
    build(creep) ||
    dismantle(creep) ||
    repairRoom(creep, true)
  );
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
  const room = getAssignedRoom(creep);
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

function getAssignedRoom(creep: Creep) {
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
    delete creep.memory.retrieve;
  } else if (utils.getEnergy(creep) < 1) {
    creep.memory.delivering = false;
    delete creep.memory.transferTo;
  }

  if (isStuck(creep)) {
    moveRandomDirection(creep);
    delete creep.memory.retrieve;
    delete creep.memory.transferTo;
    delete creep.memory.path;
  } else if (!creep.memory.delivering) {
    // fetch
    const source = getEnergySource(creep, freeCap);
    if (!source) return;
    const outcome = retrieveEnergy(creep, source);
    if (outcome === ERR_NOT_IN_RANGE) {
      move(creep, source);
      creep.memory.retrieve = source.id;
    }
  } else {
    // deliver
    const deliverTo = getStructureToFill(creep);
    if (!deliverTo) return;
    const outcome = transfer(creep, deliverTo);
    if (outcome === ERR_NOT_IN_RANGE) {
      move(creep, deliverTo);
      creep.memory.transferTo = deliverTo.id;
    }
  }
}

function getEnergySource(creep: Creep, freeCap: number) {
  return (
    getNearbyEnergySource(creep.pos, freeCap) ??
    getMemorizedEnergySource(creep) ??
    getCarrierRoomEnergySource(creep, freeCap) ??
    getCarrierGlobalEnergySource(creep, freeCap)
  );
}

function getMemorizedEnergySource(creep: Creep) {
  const id = creep.memory.retrieve;
  if (!id) return;
  const target = Game.getObjectById(id);
  if (target && utils.getEnergy(target) > 0) return target;
  return;
}

function getStructureToFill(creep: Creep) {
  return (
    getStructureToFillHere(creep.pos) ??
    getMemorizedStructureToFill(creep) ??
    getStructureToFillInAssignedRoom(creep) ??
    utils.getStorage(getAssignedRoom(creep))
  );
}

function getMemorizedStructureToFill(creep: Creep) {
  const deliverToId = creep.memory.transferTo;
  if (!deliverToId) return;
  const deliverTo = Game.getObjectById(deliverToId);
  if (!deliverTo || !shouldFill(deliverTo)) return;
  return deliverTo;
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
  const { upstream, downstream } = getTransfererTargets(creep);
  if (!upstream || !downstream) {
    recycleCreep(creep);
    return;
  } else if (!creep.memory.workStartTime && creep.pos.isNearTo(upstream) && creep.pos.isNearTo(downstream)) {
    creep.memory.workStartTime = Game.time;
  }
  if (Math.random() < 0.1 && creep.pos.lookFor(LOOK_STRUCTURES).length > 0) {
    move(creep, utils.getPosBetween(upstream.pos, downstream.pos)); // stay out of roads and stuff
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

function getTransfererTargets(creep: Creep) {
  const upstreamId = creep.memory.retrieve;
  const downstreamId = creep.memory.transferTo;
  const upstream = upstreamId ? Game.getObjectById(upstreamId) : undefined;
  const downstream = downstreamId ? Game.getObjectById(downstreamId) : undefined;
  return {
    upstream: upstream && utils.isLink(upstream) ? upstream : undefined,
    downstream: downstream && utils.isStorage(downstream) ? downstream : undefined
  };
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
    if (isStuck(creep)) {
      delete creep.memory.path; // replan
      moveRandomDirection(creep);
    } else if (!followMemorizedPath(creep)) {
      creep.memory.path = utils.getPath(creep.pos, flag.pos, 0, false);
    }
  } else {
    moveRandomDirection(creep);
  }
}

function evadeHostiles(creep: Creep) {
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
  updateRoomVisuals(room);
  handleRoomTowers(room);
  if (!room.memory.costMatrix || utils.gotSpareCpu()) {
    room.memory.costMatrix = utils.getFreshCostMatrix(room.name).serialize();
    room.memory.costMatrixCreeps = utils.getFreshCostMatrixCreeps(room.name).serialize();
  }
  if (Math.random() < 0.1 && utils.gotSpareCpu()) handleRoomObservers(room);
  utils.handleHostilesInRoom(room);
  if (utils.gotSpareCpu()) utils.updateRoomLayout(room);
  utils.handleLinks(room);
  if (!room.memory.score) utils.updateRoomScore(room);
  utils.checkRoomCanOperate(room);
  if (Math.random() < 0.1 && utils.gotSpareCpu()) updateStickyEnergy(room);
  spawnLogic.spawnCreepsInRoom(room);
  if (Math.random() < 0.1 && utils.gotSpareCpu()) handleRoads(room);
  updateRoomEnergy(room);
  if (Math.random() < 0.01) updateControllerProgress(room);
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

  const hostiles: (Creep | PowerCreep)[] = room.find(FIND_HOSTILE_CREEPS);
  Array.prototype.push.apply(hostiles, room.find(FIND_HOSTILE_POWER_CREEPS));

  const target = hostiles
    .filter(hostile => hostile.pos.findInRange(towers, room.memory.towerMaxRange ?? defaultRange).length > 0)
    .sort((a, b) => a.hits - b.hits)[0]; // weakest
  if (!target) return;

  room.memory.towerLastTarget = target.id;
  room.memory.towerLastTargetHits = target.hits;

  logTarget(room, towers, target);
  for (const tower of towers) engageTarget(tower, target);
}

function logTarget(room: Room, towers: StructureTower[], target: Creep | PowerCreep) {
  console.log(
    room,
    towers.length,
    "towers targeting hostile",
    target,
    target.hits,
    "/",
    target.hitsMax,
    "hits within range of",
    room.memory.towerMaxRange
  );
}

function handleRoomObservers(room: Room) {
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

          return;
        }
      }
    }
  }
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

function getDestructibleWallAt(pos: RoomPosition) {
  const walls = pos.lookFor(LOOK_STRUCTURES).filter(utils.isDestructibleWall);
  if (walls.length && walls[0].destroy() === ERR_NOT_OWNER) return walls[0];
  return;
}

function updateFlagAttack() {
  const flagAttack = Game.flags.attack;
  if (flagAttack) {
    if (
      flagAttack.room &&
      !getDestructibleWallAt(flagAttack.pos) &&
      getTargetsInRoom(flagAttack.room).length < 1
    ) {
      flagAttack.remove(); // have visibility to the room and it's clear of hostiles
    } else {
      return; // current flag is still valid (to the best of our knowledge)
    }
  }
  // no flag, find new targets

  let targets: (Structure | Creep | PowerCreep)[] = [];
  for (const r in Game.rooms) {
    const room = Game.rooms[r];
    const controller = room.controller;
    if (!controller) continue;
    if (!controller.my) continue;
    if (!utils.isReservationOk(controller)) continue;

    targets = targets.concat(
      getTargetsInRoom(room).filter(tgt => tgt.pos.findInRange(FIND_MY_STRUCTURES, 10).length > 0)
    );
  }
  const target = targets[Math.floor(Math.random() * targets.length)];
  if (target) {
    target.pos.createFlag("attack", COLOR_RED, COLOR_BROWN);
    utils.msg(target, "targeted!");
  }
}

function updateFlagDismantle() {
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

        return;
      }
    }
  }
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

        if (wall && wall.destroy() === ERR_NOT_OWNER) return wall;
      }
    }
  }

  return;
}

function updateFlagReserve() {
  const flagReserve = Game.flags.reserve;
  if (flagReserve) {
    if (flagReserve.room && !utils.shouldReserveRoom(flagReserve.room)) {
      flagReserve.remove();
    } else {
      return; // current flag is still valid
    }
  }
  const targets = Memory.plan?.controllersToReserve?.map(id => Game.getObjectById(id));
  if (targets?.length && targets[0]) {
    targets[0].pos.createFlag("reserve", COLOR_ORANGE, COLOR_WHITE);
  }
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

function getCarrierRoomEnergySource(creep: Creep, minEnergy: number) {
  const room = getAssignedRoom(creep);
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

function getCarrierGlobalEnergySource(creep: Creep, minEnergy: number) {
  if (!utils.gotSpareCpu()) return;

  let sources: (Resource<ResourceConstant> | Tombstone | AnyStoreStructure | Ruin)[] = [];
  for (const room of Object.values(Game.rooms)) sources = sources.concat(getCarrierEnergySources(room));

  return sources
    .filter(source => utils.getEnergy(source) >= minEnergy)
    .map(source => ({
      value: source,
      sort: utils.getGlobalRange(creep.pos, source.pos)
    })) /* persist sort values */
    .sort((a, b) => a.sort - b.sort) /* sort */
    .map(({ value }) => value) /* remove sort values */[0];
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

function getStructureToFillHere(pos: RoomPosition) {
  const room = Game.rooms[pos.roomName];
  if (!room) return;
  const structures = pos.findInRange(FIND_MY_STRUCTURES, 1).filter(shouldFill);
  const randomIndex = Math.floor(Math.random() * structures.length);
  return structures[randomIndex]; // random target to reduce traffic jams
}

function getStructureToFillInAssignedRoom(creep: Creep) {
  const room = getAssignedRoom(creep);
  if (!room) return;
  const structures = room.find(FIND_MY_STRUCTURES).filter(shouldFill);
  const randomIndex = Math.floor(Math.random() * structures.length);
  return structures[randomIndex]; // random target to reduce traffic jams
}

function shouldFill(s: Structure) {
  return utils.isOwnedStoreStructure(s) && !utils.isLink(s) && !utils.isStorage(s) && !utils.isFull(s);
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
    if (isStuck(creep)) {
      delete creep.memory.path; // replan
      moveRandomDirection(creep);
    } else {
      return true;
    }
  }
  return;
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

function getBuildSitePriority(site: ConstructionSite<BuildableStructureConstant>) {
  const prioritizedTypes = [
    STRUCTURE_SPAWN,
    STRUCTURE_TOWER,
    STRUCTURE_STORAGE,
    STRUCTURE_CONTAINER,
    STRUCTURE_LINK,
    STRUCTURE_EXTENSION,
    STRUCTURE_ROAD,
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

/* eslint-disable max-lines-per-function */
function getRandomCoolText(): string {
  // The sign text. The string is cut off after 100 characters.
  let texts = [
    '"Mushroom, mushroom," shut, it! Get back to work!',
    "'Cause I spent half my life out there. You wouldn't disagree.",
    "'Cause we were raised. To see life as fun. And take it if we can.",
    "A memory of a time when I tried so hard and got so far.",
    "A warrior from afar, are you? May you enjoy victory in battle. Umbasa.",
    "Ah, remember me, I used to live for music (Baby)",
    "Ah, we meet again. Fancy that. Hope you find something that suits you.",
    "Ah, you loved me as a loser, but now you're worried that I just might win",
    "All done? Then be gone. I work alone.",
    "And I've seen him at work, when that light goes on in his mind.",
    "Are you begging for a magic lesson?",
    "Are you here to face the Demons?",
    "Are you here to fight the Demons?",
    "Art thou done? May thine strength help the world be mended.",
    "As they croak, I see myself in the pistol smoke",
    "Assignment complete! Er, oh, no, wait, my bad... There's still one mission to go. Apologies.",
    "Be you brave knight or depraved slave, the Demons will snatch your soul, then you'll go mad.",
    "Been spendin' most their lives livin' in a gangsta's paradise.",
    "Brave soul, who fears not death. Prithee, lull the Old One back to its ancient slumber.",
    "Brave souls, who fears not death. I shall guide you to the Nexus.",
    "But you see that line there moving through the station?",
    "By the Beard!",
    "Come on guys! Rock and Stone!",
    "D'you notice? D'you know? Do you see me? Do you see me?",
    "D'you see me? D'you see? Do you like me? Do you like me standing there?",
    "Dedicated to what they do and give a hundred percent.",
    "Did I hear a Rock and Stone?",
    "Did you ever visit the Valley of Defilement?",
    "Do come back alive. I need your business.",
    "Do keep in mind that using firearms for anything besides combat is strictly against regulations.",
    "Do you seek the power of God?",
    "Don't you just walk away!",
    "Eh, it's not good, it doesn't look good",
    "Eight years in the makin', patiently waitin' to blow.",
    "Enough about the mushrooms! We all know it's a mushroom! We get it!",
    "Even my momma thinks that my mind is gone",
    "Every encounter... is gonna be much more difficult.",
    "Everybody's runnin', but half of them ain't lookin'",
    "Fifteen percent concentrated power of will. Five percent pleasure, fifty percent pain.",
    "FIGHT! WIN! PREVAIL!",
    "First we take Manhattan, then we take Berlin. I am guided.",
    "First we take Manhattan, then we take Berlin. I don't like your fashion business, mister.",
    "First we take Manhattan, then we take Berlin. I'd really like to live beside you, baby.",
    "Five percent pleasure, fifty percent pain. And a hundred percent reason to remember the name.",
    "Fool, death ain't nothin' but a heart beat away. I'm livin' life do or die, what can I say?",
    "Fool, I'm the kinda G the little homies wanna be like",
    "For Karl!",
    "For Rock and Stone!",
    "For Teamwork!",
    "For the love of God… I've had enough humiliation for one lifetime.",
    "For those about to Rock and Stone, we salute you!",
    "Forget Mike, nobody really knows how or why he works so hard.",
    "Galaxies finest!",
    "Gentlemen, this is about combat.",
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
    "He feels so unlike everybody else, alone.",
    "He knows how to work with what he's got, makin' his way to the top.",
    "He's only focused on what he wrote, his will is beyond reach.",
    "Heh heh heh. C'mon, let's be friends, what do you say! No need to drag each other down.",
    "Hello again. I'm keeping a close watch on your belongings. Rest assured.",
    "Help! Helppp! Soul-starved soldiers are after me!",
    "Him and his crew are known around as one of the best.",
    "Hm? I haven't seen you around these parts. Bah, what does it matter?",
    "Hold it friend! Going so soon?",
    "How do you do it? I can't imagine what it takes to slay a Demon…If only I could assist in this fight",
    "How many nights I prayed for this, to let my work begin",
    "I ain't got no Visa. I ain't got no Red American Express.",
    "I ain't never crossed a man that didn't deserve it",
    "I am not done yet.",
    "I can see, that you have killed in the past… No one can blame you for that.",
    "I can't control it, we're going down!",
    "I can't live a normal life, I was raised by the street",
    "I don't got a huge ol' house, I rent a room in a house",
    "I don't like these drugs that keep you thin. I don't like what happened to my sister.",
    "I don't need the G's or the car keys. Boy, I like you just the way you are.",
    "I find something odd about this place. It brims with grime, but at once feels strangely pure.",
    "I gotta be down with the hood team",
    "I guess they can't, I guess they won't",
    "I guess they front, that's why I know my life is out of luck, fool",
    "I have always been here in this Nexus.",
    "I have no business with your kind. I'm busy, begone with you!",
    "I keep the candles lit and serve the brave Demon slayers who are trapped here.",
    "I love your body and your spirit and your clothes",
    "I see. You wish to train yourself in stoicism. Very well. I pray we meet again.",
    "I shall lull the Old One back to slumber.",
    "I take a look at my life and realize there's nothin' left",
    "I thank you for those items that you sent me, ha ha ha ha",
    "I told you, I told you, told you I was one of those",
    "I walk through the valley of the shadow of death",
    "I was here when the Old One awakened, and I will be here when It rests once again.",
    "I wish I could do more, but I am ignorant of the world beyond these walls.",
    "I, too, am on a quest to fight the Demons in the name of the Lord.",
    "I, too, must contribute how I can, for we are indebted to our honorable defenders.",
    "I'm 23 now but will I live to see 24? The way things is going I don't know.",
    "I'm a educated fool with money on my mind. Got my ten in my hand and a gleam in my eye.",
    "I'm a loc'd out gangsta, set trippin' banger. And my homies is down, so don't arouse my anger.",
    "I'm coming now, I'm coming to reward them. First we take Manhattan, then we take Berlin.",
    "I'm guided by a signal in the heavens (Guided, guided)",
    "I'm guided by the beauty of our weapons (Ooh, ooh)",
    "I'm guided by this birthmark on my skin (I am guided by)",
    "I'm not afraid! I'll tear you limb from limb!",
    "I'm sorry. I cannot die. Not while the Nexus binds me…",
    "I'm surprised it got so far. Things aren't the way they were before.",
    "I've been blastin' and laughin' so long",
    "If I had a credit for every Rock and Stone.",
    "If only my real job was as easy as playing a video game...",
    "If they can't understand it, how can they reach me?",
    "If you don't Rock and Stone, you ain't comin' home!",
    "If you Rock and Stone, you're never alone!",
    "In spite of the fact that some people still think that they know him.",
    "In the end, it doesn't even matter. I had to fall to lose it all.",
    "In the end, it doesn't even matter. I've put my trust in you.",
    "In the end, it doesn't even matter. One thing, I don't know why.",
    "In the end, it doesn't even matter",
    "Increase fear and suspicion",
    "Is there a single sane person left in Boletaria?",
    "It doesn't even matter how hard you try. Keep that in mind, I designed this rhyme.",
    "It starts with one... One thing I don't know why.",
    "It's going on in the kitchen, but I don't know what's cookin'",
    "It's like a design is written in his head every time.",
    "It's like this, y'all, c'mon. This is ten percent luck, twenty percent skill.",
    "It's not about the salary, it's all about reality and makin' some noise.",
    "Just do it up!",
    "Keep spendin' most our lives. Livin' in a gangsta's paradise.",
    "Last one to Rock and Stone pays for the first round!",
    "Leave No Dwarf Behind!",
    "Let strength be granted, so the world might be mended... So the world might be mended.",
    "Let's get back to equal justice",
    "Let's not have a repeat of the flamethrower incident in the mess hall...",
    "Let's Rock and Stone!",
    "Like that! Rock and Stone!",
    "Listen baby girl (yeah). I ain't got a motorboat, but I can float ya boat.",
    "Look at the situation they got me facing",
    "Makin' a story, makin' sure his clique stays up.",
    "May I share God's power with you? Do not be bashful; we are both cut from the same cloth.",
    "May the heavens gaze favorably upon you. Umbasa.",
    "May-May-Ma-Mayday-Mayday",
    "Me be treated like a punk, you know that's unheard of",
    "Mother control, I can't, I can't control it",
    "My father he liked me. Oh, he liked me. Does anyone care? Understand what I've become.",
    "My mother she'd hold me. She'd hold me. When I was out there.",
    "My old Mother would be proud indeed! Aren't you proud of me too?",
    "Never asking for someone's help, or to get some respect.",
    "Never concerned with status, but still leavin' 'em starstruck.",
    "No matter how far I venture, only the soul starved remain.",
    "No, he's livin' proof, got him rockin' the booth.",
    "None can stand before us!",
    "Not good, this is not good!",
    "O Lord, punish me. For I have not the strength to punish myself.",
    "Oh, fellow disciple, you seek the power of God?",
    "Oh, I can hardly believe it! The fact that I am helping to save the world! Oh, Saint Urbain…Umbasa.",
    "Oh, is that you again? Do you have further gifts to offer?",
    "Oh, it's you. Did you cleanse the world of another dark soul today?",
    "Oh, my, how has this happened?",
    "Oh! the Demons haven't got to you, have they?",
    "On my knees in the night, sayin' prayers in the streetlight",
    "Power and the money, money and the power. Minute after minute, hour after hour.",
    "Pushed as far as I can go.",
    "Put it together himself, now the picture connects.",
    "R&D asked me to remind you never to look directly at the beam while firing.",
    "Remember me, I brought your groceries in (Ooh, baby, yeah)",
    "Ridiculous, without even tryin', how do they do it?",
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
    "She'd hold me. When I was out there. My father. My father he liked me.",
    "Something better than I am. I miss you. I miss 'cause I liked it. 'Cause I liked it.",
    "Soul of the lost, withdrawn from its vessel. Let strength be granted so the world might be mended.",
    "Soul of the mind, key to life's ether. Soul of the lost, withdrawn from its vessel.",
    "State of emergency",
    "Stay the path, and you will soon be a monster yourself! Hahahahahah!",
    "Still alive? I am impressed.",
    "Stone and Rock! ...Oh, wait...",
    "Stone.",
    "Talk to me, girl",
    "Tell me why are we so blind to see, that the ones we hurt are you and me?",
    "Thank goodness you are safe! I was worried sick about you.",
    "That's it lads! Rock and Stone!",
    "The King? He's gone mad like the rest of them. Or perhaps he was mad in the first place.",
    "The monkey and the plywood violin. I practiced every night, now I'm ready.",
    "The Old One and I shall slumber interminably. That is the way it must be.",
    "The Old One, without Demons to feed it souls, will a new servant seek, and lure you to its bosom.",
    "There are no secrets here; only a tired, emaciated frame.",
    "There's only one thing you should know. I tried so hard and got so far.",
    "There's only one thing you should know. I've put my trust in you.",
    "They say I gotta learn, but nobody's here to teach me",
    "They sentenced me to 20 years of boredom. For trying to change the system from within.",
    "This is bad… Not a single person left… Why on Earth? How did all of this happen… Father!",
    "This is ten percent luck, twenty percent skill. Fifteen percent concentrated power of will.",
    "This place is buzzing with pests fattened on a diet of souls.",
    "This place? It's a proper mound of rubbish. All the rot of the world, living or not, ends up here.",
    "Thou seeketh soul power, dost thou not? Then touch the Demon inside me.",
    "Tick tock, team! We're not getting any younger down here!",
    "Time is a valuable thing. Watch it fly by as the pendulum swings.",
    "To see life as fun. And take it if we can. My mother. My mother she'd hold me.",
    "Too much television watchin', got me chasing dreams",
    "Understand the things I say. Don't turn away from me.",
    "Watch it count down to the end of the day. The clock ticks life away.",
    "Watch the time go right out the window. Tryin' to hold on.",
    "We are indebted to you, for you fight on our behalf.",
    "We are unbreakable!",
    "We can work without the perks just you and me. Thug it out 'til we get it right.",
    "We fight for Rock and Stone!",
    "We have long await'd you, slayer of Demons.",
    "We rock!",
    "WE'RE RICH!",
    "We're the best!",
    "We're welcome here as long as we keep slashing up Demons. Hahahahah…",
    "Well, do as you please, but don't come a-crying when it works not.",
    "Well, it's Father's Day, and everybody's wounded. First we take Manhattan, then we take Berlin.",
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
    "When I was out there. D'you know this? D'you know? You did not find me.",
    "Where's when I was young. And we didn't give a damn.",
    "Who the hell is he anyway? He never really talks much.",
    "Who would've thought he'd be the one to set the west in flames?",
    "Whoa... I know everything about everything! Ask me something, quick! Wait! Oh—it passed.",
    "Ye covetous one, let it be known, we shall defend our heart and home to the death.",
    "Yeaahhh! Rock and Stone!",
    "Yeah, yeah, Rock and Stone.",
    "Yer want to play, well, you've got to pay. Don't you agree?",
    "Yes, we are fortunate indeed to have you. Now, go forth, and destroy every last Demon.",
    "You and your homies might be lined in chalk. I really hate to trip, but I gotta loc.",
    "You better watch how you talkin' and where you walkin'",
    "You came for Demon Souls? Or to save this land, and be remembered as a Hero?",
    "You did not find. Does anyone care? Unhappiness. Where's when I was young.",
    "You don't deserve to die, so let me give you some advice.",
    "You have a heart of gold. Don't let them take it from you.",
    "You know the way to stop me, but you don't have the discipline",
    "You may be a great Demon hunter, but I fear you may not be ready.",
    "You must lull the Old One back to Its slumber, and seal it away for all eternity.",
    "You there…I can sense it. You can hear the voice of God. And you are battling those terrible Demons.",
    "You wouldn't even recognize me anymore. Not that you knew me back then.",
    "You're simply unlucky. Worry not. Stay by me, and my luck'll rub off on you soon enough!"
  ];
  if (Memory.signTexts) texts = texts.concat(Memory.signTexts);
  const randomIndex = Math.floor(Math.random() * texts.length);
  return texts[randomIndex];
}
/* eslint-enable max-lines-per-function */

function getUpgraderSpot(room: Room) {
  const storage = utils.getStorage(room);
  if (!storage) return;
  return utils
    .getSurroundingPlains(storage.pos, 0, 1, true)
    .map(pos => ({
      pos,
      sort:
        pos
          .look()
          .map(o => (o.flag ? 1 : o.terrain === "swamp" ? 4 : 2))
          .reduce((aggregated, value) => aggregated + value, 0) + Math.random()
    })) /* persist sort values */
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
    .filter(s => s.hits < s.hitsMax && s.hits < (s.room.memory.maxHitsToRepair ?? Number.POSITIVE_INFINITY))
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

function repairRoom(creep: Creep, anyHits: boolean) {
  const room = getAssignedRoom(creep);
  if (!room) return false;
  const minHitsToRepair = 20000;
  let repairTarget: AnyStructure | undefined = room
    .find(FIND_STRUCTURES)
    .filter(
      s => (anyHits && s.hits < s.hitsMax) || s.hits <= s.hitsMax - minHitsToRepair || s.hits < s.hitsMax / 2
    ) /* damage worth moving to */
    .map(target => ({
      target,
      sort: target.hits
    })) /* persist sort values */
    .sort((a, b) => a.sort - b.sort) /* sort */
    .map(({ target }) => target) /* remove sort values */[0];
  const constructionSiteCount = room.find(FIND_MY_CONSTRUCTION_SITES).length;
  if (constructionSiteCount > 0 && repairTarget && repairTarget.hits > minHitsToRepair)
    repairTarget = undefined;
  room.memory.maxHitsToRepair = minHitsToRepair + (repairTarget?.hits ?? 0);
  room.memory.repairPos = repairTarget?.pos;
  if (!repairTarget) return false;
  if (creep.repair(repairTarget) === ERR_NOT_IN_RANGE) move(creep, repairTarget);
  return true;
}

function workerRetrieveEnergy(creep: Creep) {
  const room = getAssignedRoom(creep);
  if (!room) return;
  const source = room
    .find(FIND_STRUCTURES)
    .filter(s => (utils.isStorage(s) || utils.isContainer(s)) && utils.getEnergy(s) > 0)
    .map(value => ({
      value,
      sort: utils.getGlobalRange(creep.pos, value.pos)
    })) /* persist sort values */
    .sort((a, b) => a.sort - b.sort) /* sort */
    .map(({ value }) => value) /* remove sort values */[0];
  if (!source) return;
  if (retrieveEnergy(creep, source) === ERR_NOT_IN_RANGE) move(creep, source);
}

function updateRoomVisuals(room: Room) {
  const polyPoints = room.memory.polyPoints;
  if (polyPoints) new RoomVisual(room.name).poly(polyPoints);

  const textStyle = {
    color: "#FF0000"
  };

  const repairPos = room.memory.repairPos;
  if (repairPos) new RoomVisual(room.name).text("🔧", repairPos, textStyle);

  for (const spawn of room.find(FIND_MY_SPAWNS))
    if (spawn.spawning)
      new RoomVisual(room.name).text(utils.creepNameToEmoji(spawn.spawning.name), spawn.pos, textStyle);

  if (room.controller?.progressTotal) {
    const text = utils.getControllerText(room);
    if (text && text.length > 0) new RoomVisual(room.name).text(text, room.controller.pos, textStyle);
  }
}

function creepTalk(creep: Creep) {
  if (creep.memory.say && creep.memory.say.length > 0) {
    const nextPart = creep.memory.say.shift();
    if (nextPart) creep.say(nextPart, true);
  } else if (Math.random() < 0.1) {
    creep.say(utils.creepNameToEmoji(creep.name), true);
  } else if (Math.random() < 0.004) {
    creep.memory.say = splitTextToSay(getRandomCoolText());
  }
}

function splitTextToSay(text: string): string[] | undefined {
  if (text.length <= 10) return [text];
  const parts = [];
  while (text.trim().length > 0) {
    let part = "";
    while (text.trim().length > 0 && part.length < 10) {
      /* 0 = whole thing, 1 = text, 2 = non-text */
      const match = /^([\w']*)(\W*)/.exec(text);
      if (match && part.length + match[1].length <= 10) {
        // add whole word to part
        part += match[0];
        text = text.substring(match[0].length);
      } else if (match && part.length < 1) {
        // add a partial word
        part += match[0].substring(0, 9) + "-";
        text = text.substring(9);
      } else {
        break;
      }
    }
    parts.push(part.trim());
  }
  return parts;
}

function removeConstructionSitesInRoomsWithoutVisibility(): void {
  const sites = Object.values(Game.constructionSites).filter(site => !site.room);
  for (const site of sites) site.remove();
}

function handleRoads(room: Room): void {
  const roads = room.find(FIND_STRUCTURES).filter(isRoad);
  for (const road of roads) {
    road.notifyWhenAttacked(false);
  }
}

function isRoad(structure: Structure): structure is StructureRoad {
  if (!("structureType" in structure)) return false;
  return structure.structureType === STRUCTURE_ROAD;
}

function engageTarget(myUnit: StructureTower | Creep, target: Structure | Creep | PowerCreep): number {
  if (isEnemy(target) || target instanceof StructureWall) {
    return myUnit.attack(target);
  } else if (target instanceof Creep || target instanceof PowerCreep) {
    return myUnit.heal(target);
  } else {
    return myUnit.repair(target);
  }
}

function isEnemy(object: Structure | Creep | PowerCreep): boolean {
  if (object instanceof Creep || object instanceof PowerCreep) return object.my === false;
  return isOwnedStructure(object) && object.my === false;
}

function isOwnedStructure(structure: Structure): structure is AnyOwnedStructure {
  return (structure as { my?: boolean }).my !== undefined;
}

function isStuck(creep: Creep): boolean {
  return (creep.memory.lastMoveTime || 0) < Game.time - 8;
}

function moveRandomDirection(creep: Creep): void {
  const directions = [TOP, TOP_RIGHT, RIGHT, BOTTOM_RIGHT, BOTTOM, BOTTOM_LEFT, LEFT, TOP_LEFT];
  const direction = directions[Math.floor(Math.random() * directions.length)];
  creep.move(direction);
}

function move(creep: Creep, destination: Destination): CreepMoveReturnCode | -2 | -7 | -5 {
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

function withdraw(creep: Creep, destination: Destination): ScreepsReturnCode {
  if (destination instanceof Structure || destination instanceof Tombstone || destination instanceof Ruin) {
    const actionOutcome = creep.withdraw(destination, RESOURCE_ENERGY);
    return actionOutcome;
  }
  return ERR_INVALID_TARGET;
}

function pickup(creep: Creep, destination: Destination): -8 | CreepActionReturnCode {
  if (destination instanceof Resource) {
    const actionOutcome = creep.pickup(destination);
    return actionOutcome;
  }
  return ERR_INVALID_TARGET;
}

function getRoomToClaim(aroundRooms: Room[]): string | undefined {
  let bestScore = Number.NEGATIVE_INFINITY;
  let bestRoomName;

  for (const room of aroundRooms) {
    const exits = Game.map.describeExits(room.name);
    const claimableRoomNames = Object.values(exits).filter(
      roomName =>
        utils.isRoomSafe(roomName) &&
        Memory.rooms[roomName]?.canOperate &&
        utils.getRoomStatus(roomName) === utils.getRoomStatus(room.name) &&
        !aroundRooms.map(roomAround => roomAround.name).includes(roomName) &&
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

function updateControllerProgress(room: Room) {
  room.memory.controllerProgress = room.controller?.progress;
  room.memory.controllerProgressTime = new Date().getTime();
}
