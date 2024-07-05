// When compiling TS to JS and bundling with rollup, the line numbers and file names in error messages change
// This utility uses source maps to get the line numbers and file names of the original, TS source code
import * as utils from "utils";
import { ErrorMapper } from "utils/ErrorMapper";

declare global {
  type Role =
    | "attacker"
    | "carrier"
    | "explorer"
    | "harvester"
    | "infantry"
    | "reserver"
    | "transferer"
    | "upgrader"
    | "worker";

  type Action =
    | "build"
    | "harvest"
    | "moveTo"
    | "pickup"
    | "recycleCreep"
    | "repair"
    | "reserveController"
    | "transfer"
    | "upgradeController"
    | "withdraw";

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
    cpuLog: Record<string, CpuLogEntry>;
    cpuUsedRatio: number;
    maxTickLimit: number;
    plan: Plan;
    username: string;
    wipeOut: boolean;
  }

  interface Plan {
    controllersToReserve: Id<StructureController>[];
    fillSpawnsFromStorage: boolean;
    fillStorage: boolean;
    maxRoomEnergy: number;
    maxRoomEnergyCap: number;
    minTicksToDowngrade: number;
    needAttackers: boolean;
    needCarriers: boolean;
    needExplorers: boolean;
    needHarvesters: boolean;
    needInfantry: boolean;
    needReservers: boolean;
    needTransferers: boolean;
    needUpgraders: boolean;
    needWorkers: boolean;
  }

  interface FlagMemory {
    steps: number;
    initTime: number;
  }

  interface RoomMemory {
    canOperate: boolean;
    costMatrix?: number[];
    harvestSpots: RoomPosition[];
    hostileRangedAttackParts: number;
    hostilesPresent: boolean;
    lastTimeFlagEnergyConsumerSet: number;
    remoteHarvestScore: number;
    repairTargets: Id<Structure>[];
    score: number;
    stickyEnergy: Record<Id<AnyStoreStructure>, number>;
    stickyEnergyDelta: Record<Id<AnyStoreStructure>, number>;
    upgradeSpots?: RoomPosition[];
  }

  interface EnergyStore {
    id: Id<EnergySource | AnyStoreStructure>;
    energy: number;
    freeCap: number;
  }

  interface CreepMemory {
    action?: Action;
    build?: Id<ConstructionSite>;
    container?: Id<StructureContainer>;
    debug?: boolean;
    deliveryTasks?: DeliveryTask[];
    destination?: DestinationId | RoomPosition;
    lastMoveTime?: number;
    lastActiveTime?: number;
    link?: Id<StructureLink>;
    pathKey?: string;
    phaseIndex?: number;
    phases?: Phase[];
    pos: RoomPosition;
    retrieve?: Id<Structure | Tombstone | Ruin | Resource>;
    role: Role;
    sourceId?: Id<Source>;
    storage?: Id<StructureStorage>;
    stroke: string;
    strokeWidth: number;
    transferred?: boolean;
    transferTo?: Id<Structure>;
    upgrade?: Id<StructureController>;
  }

  interface Phase {
    retrieve?: Id<Structure>;
    transfer?: Id<Structure>;
    move?: RoomPosition[];
  }

  interface DeliveryTask {
    isDelivery: boolean;
    destination: Id<Structure | Tombstone | Ruin | Resource>;
    energy: number;
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
  utils.logCpu("mem");
  if ((Memory.maxTickLimit || 0) < Game.cpu.tickLimit) Memory.maxTickLimit = Game.cpu.tickLimit;
  if (Math.random() < 0.1) {
    for (const key in Memory.rooms) {
      if (!Game.rooms[key]) delete Memory.rooms[key].costMatrix;
    }
    for (const key in Memory.creeps) {
      if (!Game.creeps[key]) delete Memory.creeps[key];
    }
    purgeFlags();
    purgeFlagsMemory();
  }
  if (!Memory.username) utils.setUsername();
  checkWipeOut();
  utils.logCpu("mem");
  if (Math.random() < 0.01 || gotSpareCpu()) updatePlan();
  for (const r in Game.rooms) handleRoom(Game.rooms[r]);
  spawnCreeps();
  utils.logCpu("update flags");
  updateFlagAttack();
  updateFlagClaim();
  updateFlagReserve();
  updateFlagDismantle();
  utils.logCpu("update flags");
  handleCreeps();
  Memory.cpuUsedRatio = Game.cpu.getUsed() / Game.cpu.limit;
  utils.logCpu("main");
  utils.cpuInfo(); // after everything!
});

function updatePlan() {
  utils.logCpu("updatePlan");
  const storageMin = getStorageMin();
  const allSpawnsFull = areAllSpawnsFull();
  const needHarvesters = getSourceToHarvest() ? true : false;
  Memory.plan = {
    controllersToReserve: utils.getControllersToReserve().map(controller => controller.id),
    fillSpawnsFromStorage: storageMin >= 800000 && !allSpawnsFull,
    fillStorage: (storageMin < 150000 && !needHarvesters) || allSpawnsFull,
    needAttackers: needAttackers(),
    needCarriers: needCarriers(),
    needExplorers: needExplorers(),
    needHarvesters: storageMin < 900000 && needHarvesters,
    needInfantry: needInfantry(),
    needReservers: needReservers(),
    needTransferers: needTransferers(),
    needUpgraders: needUpgraders(),
    needWorkers: needWorkers(),
    maxRoomEnergy: Math.max(...Object.values(Game.spawns).map(spawn => spawn.room.energyAvailable)),
    maxRoomEnergyCap: Math.max(...Object.values(Game.spawns).map(s => s.room.energyCapacityAvailable)),
    minTicksToDowngrade: getMinTicksToDowngrade()
  };
  utils.logCpu("updatePlan");
}

function getMinTicksToDowngrade() {
  utils.logCpu("getMinTicksToDowngrade");
  const value = Math.min(
    ...Object.values(Game.rooms)
      .filter(room => room.controller && room.controller.my)
      .map(room => room.controller?.ticksToDowngrade || Number.POSITIVE_INFINITY)
  );
  utils.logCpu("getMinTicksToDowngrade");
  return value;
}

function getStorageMin() {
  utils.logCpu("getStorageMin");
  const storages = Object.values(Game.structures).filter(utils.isStorage);
  if (storages.length < 1) return 0;

  let storageMin = Number.POSITIVE_INFINITY;
  for (const storage of storages) {
    storageMin = Math.min(storageMin, storage.store.getUsedCapacity(RESOURCE_ENERGY));
  }
  utils.logCpu("getStorageMin");
  return storageMin;
}

function needExplorers() {
  utils.logCpu("needExplorers()");
  const value =
    utils.getCreepCountByRole("explorer") < 2 &&
    Object.values(Game.rooms).filter(
      room =>
        room.controller &&
        room.controller.my &&
        CONTROLLER_STRUCTURES[STRUCTURE_OBSERVER][room.controller.level] > 0
    ).length < 1;
  utils.logCpu("needExplorers()");
  return value;
}

function areAllSpawnsFull() {
  utils.logCpu("areAllSpawnsFull()");
  for (const room of Object.values(Game.rooms)) {
    utils.logCpu("areAllSpawnsFull()");
    if (room.energyAvailable < room.energyCapacityAvailable) return false;
  }
  utils.logCpu("areAllSpawnsFull()");
  return true;
}

function handleCreeps() {
  utils.logCpu("handleCreeps()");
  for (const c in Game.creeps) {
    if (!Game.creeps[c].spawning) {
      utils.logCpu("creep: " + c);
      const creep = Game.creeps[c];
      creep.memory.transferred = false;
      if (creep.memory.pos?.roomName !== creep.pos.roomName) delete creep.memory.pathKey;

      const role = creep.memory.role;
      if (role === "attacker") handleAttacker(creep);
      else if (role === "carrier") handleCarrier(creep);
      else if (role === "explorer") handleExplorer(creep);
      else if (role === "harvester") handleHarvester(creep);
      else if (role === "infantry") handleInfantry(creep);
      else if (role === "reserver") handleReserver(creep);
      else if (role === "transferer") handleTransferer(creep);
      else if (role === "upgrader") handleUpgrader(creep);
      else if (role === "worker") handleWorker(creep);

      if (!isPosEqual(creep.memory.pos, creep.pos)) creep.memory.lastMoveTime = Game.time;
      creep.memory.pos = creep.pos;
      utils.logCpu("creep: " + c);
    }
  }
  utils.logCpu("handleCreeps()");
}

function handleExplorer(creep: Creep) {
  utils.logCpu("handleExplorer(" + creep.name + ")");
  creep.notifyWhenAttacked(false);
  if (creep.pos.roomName !== creep.memory.pos?.roomName || !moveTowardMemory(creep)) {
    utils.logCpu("handleExplorer(" + creep.name + ") getExit");
    const destination = utils.getExit(creep.pos, !creep.ticksToLive || creep.ticksToLive > 300, false);
    utils.logCpu("handleExplorer(" + creep.name + ") getExit");
    if (destination) {
      move(creep, destination);
      utils.setDestination(creep, destination);
    }
  }
  utils.logCpu("handleExplorer(" + creep.name + ")");
}

function handleUpgrader(creep: Creep) {
  utils.logCpu("handleUpgrader(" + creep.name + ")");
  // controller
  const controllerId = creep.memory.upgrade;
  let controller;
  if (controllerId) controller = Game.getObjectById(controllerId);
  if (!controller) controller = getControllerToUpgrade(creep.pos, false);
  utils.logCpu("handleUpgrader(" + creep.name + ")");
  if (!controller) return;
  creep.memory.upgrade = controller.id;
  // actions
  if (utils.isEmpty(creep)) upgraderRetrieveEnergy(creep, controller);
  if (controller) {
    const outcome = creep.upgradeController(controller);
    if (outcome === ERR_NOT_IN_RANGE) move(creep, controller);
  }
  utils.logCpu("handleUpgrader(" + creep.name + ")");
}

function upgraderRetrieveEnergy(creep: Creep, controller: StructureController) {
  const storeId = creep.memory.storage || creep.memory.container;
  let store;
  if (storeId) store = Game.getObjectById(storeId);
  if (!store || utils.getEnergy(store) < 1) {
    store = controller.pos.findClosestByRange(
      controller.pos.findInRange(FIND_STRUCTURES, 10, {
        filter(object) {
          return utils.isStorage(object) || utils.isContainer(object);
        }
      })
    );
    if (!store || utils.getEnergy(store) < 1) {
      store = controller.pos.findClosestByRange(controller.pos.findInRange(FIND_DROPPED_RESOURCES, 10));
      if (!store || utils.getEnergy(store) < 1) return;
    }
    if (utils.isStorage(store)) creep.memory.storage = store.id;
    else if (utils.isContainer(store)) creep.memory.container = store.id;
  }
  let withdrawOutcome;
  if (utils.isResource(store)) {
    withdrawOutcome = creep.pickup(store);
  } else {
    withdrawOutcome = creep.withdraw(store, RESOURCE_ENERGY);
  }
  if (withdrawOutcome === ERR_NOT_IN_RANGE) move(creep, store);
  if (isStuck(creep)) moveRandomDirection(creep);
}

function moveRandomDirection(creep: Creep) {
  const directions = [TOP, TOP_RIGHT, RIGHT, BOTTOM_RIGHT, BOTTOM, BOTTOM_LEFT, LEFT, TOP_LEFT];
  const direction = directions[Math.floor(Math.random() * directions.length)];
  creep.move(direction);
}

function handleWorker(creep: Creep) {
  if (isStuck(creep)) {
    moveRandomDirection(creep);
    return;
  }

  if (utils.isEmpty(creep)) delete creep.memory.build;
  else if (utils.isFull(creep)) delete creep.memory.retrieve;

  if (utils.isEmpty(creep)) {
    workerRetrieveEnergy(creep);
    return;
  }
  const repairTarget = creep.pos.findInRange(FIND_STRUCTURES, 3).filter(utils.needRepair)[0];
  if (repairTarget) {
    creep.memory.lastActiveTime = Game.time;
    creep.repair(repairTarget);
  } else if (creep.memory.build) {
    build(creep);
  } else {
    const result = repair(creep) || dismantle(creep) || build(creep);
    return result;
  }
  return;
}

function workerRetrieveEnergy(creep: Creep) {
  utils.logCpu("workerRetrieveEnergy(" + creep.name + ")");
  if (creep.room.storage && retrieveEnergy(creep, creep.room.storage) === ERR_NOT_IN_RANGE) {
    move(creep, creep.room.storage);
  } else {
    const container = creep.pos.findClosestByRange(FIND_STRUCTURES, {
      filter(object) {
        return utils.isContainer(object) && utils.getEnergy(object) > 0;
      }
    });
    if (container && retrieveEnergy(creep, container) === ERR_NOT_IN_RANGE) {
      move(creep, container);
    } else {
      const resource = creep.pos.findClosestByRange(FIND_DROPPED_RESOURCES);
      if (resource && retrieveEnergy(creep, resource) === ERR_NOT_IN_RANGE) {
        move(creep, resource);
      } else {
        const closestStorage = Object.values(Game.rooms)
          .filter(room => room.storage && utils.getEnergy(room.storage) > 0)
          .map(room => ({
            storage: room.storage,
            sort: utils.getGlobalRange(creep.pos, utils.getPos(room.storage))
          })) /* persist sort values */
          .sort((a, b) => a.sort - b.sort) /* sort */
          .map(({ storage }) => storage) /* remove sort values */[0];
        if (closestStorage && retrieveEnergy(creep, closestStorage) === ERR_NOT_IN_RANGE) {
          move(creep, closestStorage);
        } else if (isStuck(creep)) {
          moveRandomDirection(creep);
        }
      }
    }
  }
  utils.logCpu("workerRetrieveEnergy(" + creep.name + ")");
}

function build(creep: Creep) {
  utils.logCpu("build(" + creep.name + ")");
  utils.logCpu("build(" + creep.name + ") find");
  let destination;
  const oldDestination = creep.memory.build;
  if (typeof oldDestination === "string") {
    destination = Game.getObjectById(oldDestination);
    if (!destination) delete creep.memory.build;
  }
  if (!destination || !(destination instanceof ConstructionSite)) {
    destination = getBuildSite(creep, false);
    if (!destination) destination = getBuildSite(creep, true);
    if (destination) utils.setDestination(creep, destination);
  }
  utils.logCpu("build(" + creep.name + ") find");
  utils.logCpu("build(" + creep.name + ") build");
  if (destination instanceof ConstructionSite) {
    creep.memory.lastActiveTime = Game.time;
    creep.memory.build = destination.id;
    if (creep.build(destination) === ERR_NOT_IN_RANGE) {
      utils.logCpu("build(" + creep.name + ") build move");
      move(creep, destination);
      utils.logCpu("build(" + creep.name + ") build move");
      utils.logCpu("build(" + creep.name + ") build");
      utils.logCpu("build(" + creep.name + ")");
      return true;
    }
  }
  utils.logCpu("build(" + creep.name + ") build");
  utils.logCpu("build(" + creep.name + ")");
  return false;
}

function getBuildSite(creep: Creep, allowMultipleBuilders: boolean) {
  utils.logCpu("getBuildSite(" + creep.name + "," + allowMultipleBuilders.toString() + ")");
  const constructionSite = utils
    .getConstructionSites()
    .filter(
      site =>
        allowMultipleBuilders ||
        Object.values(Game.creeps).filter(builder => builder.memory.build === site.id).length < 1
    )
    .map(value => ({
      value,
      sort: utils.getGlobalRange(creep.pos, utils.getPos(value))
    })) /* persist sort values */
    .sort((a, b) => a.sort - b.sort) /* sort */
    .map(({ value }) => value) /* remove sort values */[0];
  utils.logCpu("getBuildSite(" + creep.name + "," + allowMultipleBuilders.toString() + ")");
  return constructionSite;
}

function repair(creep: Creep) {
  utils.logCpu("repair(" + creep.name + ")");
  const oldDestination = creep.memory.destination;
  let destination;
  let repairTarget;
  if (typeof oldDestination === "string") destination = Game.getObjectById(oldDestination);
  if (destination instanceof Structure && utils.needRepair(destination)) repairTarget = destination;
  if (!repairTarget) repairTarget = getRepairTarget(creep.pos);
  if (repairTarget) {
    utils.logCpu("repair(" + creep.name + ") tgt");
    creep.memory.lastActiveTime = Game.time;
    if (creep.repair(repairTarget) === ERR_NOT_IN_RANGE) move(creep, repairTarget);
    utils.setDestination(creep, repairTarget);
    utils.logCpu("repair(" + creep.name + ") tgt");
    utils.logCpu("repair(" + creep.name + ")");
    return true;
  }
  utils.logCpu("repair(" + creep.name + ")");
  return false;
}

function dismantle(creep: Creep) {
  utils.logCpu("dismantle(" + creep.name + ")");
  const flag = Game.flags.dismantle;
  if (!flag) return false;
  const targets = flag.pos.lookFor(LOOK_STRUCTURES);
  if (targets.length < 1) return false;
  const target = targets[0];
  creep.memory.lastActiveTime = Game.time;
  if (creep.dismantle(target) === ERR_NOT_IN_RANGE) {
    move(creep, target);
    utils.logCpu("dismantle(" + creep.name + ")");
    return true;
  }
  utils.logCpu("dismantle(" + creep.name + ")");
  return false;
}

function getRepairTarget(pos: RoomPosition) {
  utils.logCpu("getRepairTarget(" + pos.toString() + ")");
  const sources = [];
  let ids: Id<Structure<StructureConstant>>[] = [];
  for (const room of Object.values(Game.rooms)) {
    if (utils.isRoomSafe(room.name)) {
      ids = ids.concat(room.memory.repairTargets);
    }
  }
  if (ids) {
    for (const id of ids) {
      const source = Game.getObjectById(id);
      if (source) sources.push(source);
    }
    const closest = sources
      .map(value => ({
        value,
        sort: utils.getGlobalRange(pos, utils.getPos(value))
      })) /* persist sort values */
      .sort((a, b) => a.sort - b.sort) /* sort */
      .map(({ value }) => value) /* remove sort values */[0];

    if (closest) {
      const index = Memory.rooms[closest.pos.roomName].repairTargets.indexOf(closest.id);
      if (index > -1) Memory.rooms[closest.pos.roomName].repairTargets.splice(index, 1);
    }
    utils.logCpu("getRepairTarget(" + pos.toString() + ")");
    return closest;
  }
  utils.logCpu("getRepairTarget(" + pos.toString() + ")");
  return;
}

function hasEnoughEnergyForAnotherUpgrader(controller: StructureController) {
  const store = controller.pos.findClosestByRange(
    controller.pos.findInRange(FIND_STRUCTURES, 10, {
      filter(object) {
        return utils.isStorage(object) || utils.isContainer(object);
      }
    })
  );
  if (!store) return false;
  if (!utils.isContainer(store) && !utils.isStorage(store)) return false;
  const energy = utils.getEnergy(store);
  if (isNaN(energy)) return false;
  const assignedWorkParts = Object.values(Game.creeps)
    .filter(creep => creep.memory.upgrade === controller.id)
    .reduce((aggregated, item) => aggregated + item.getActiveBodyparts(WORK), 0 /* initial*/);
  if (utils.getFreeCap(store) < 1 && assignedWorkParts < 1) return true;
  const energyPerWork = energy / assignedWorkParts;
  const isEnough = energyPerWork > 160;
  return isEnough;
}

function getControllerToUpgrade(pos: RoomPosition | undefined = undefined, urgentOnly = false) {
  utils.logCpu("getControllerToUpgrade(" + (pos || "").toString() + "," + urgentOnly.toString() + ")");
  const targets = [];
  for (const i in Game.rooms) {
    const room = Game.rooms[i];
    if (room.memory.hostilesPresent) continue;
    if (!room.controller) continue;
    if (!room.controller.my) continue;
    const ticksToDowngrade = room.controller.ticksToDowngrade;
    if (urgentOnly && ticksToDowngrade > 4000) continue;
    const upgraderCount = countUpgradersAssigned(room.controller.id);
    if (!hasEnoughEnergyForAnotherUpgrader(room.controller) && (ticksToDowngrade > 4000 || upgraderCount > 0))
      continue;
    if (isControllerUpgradedEnough(room.controller)) continue;
    if (upgraderCount >= 5) continue;
    targets.push(room.controller);
  }
  const destination = targets
    .map(value => ({
      value,
      sort:
        (pos ? utils.getGlobalRange(pos, utils.getPos(value)) : 0) +
        value.ticksToDowngrade / 20 +
        Object.values(Game.creeps).filter(creep => creep.memory.upgrade === value.id).length * 100
    })) /* persist sort values */
    .sort((a, b) => a.sort - b.sort) /* sort */
    .map(({ value }) => value) /* remove sort values */[0];

  utils.logCpu("getControllerToUpgrade(" + (pos || "").toString() + "," + urgentOnly.toString() + ")");
  return destination;
}

function isControllerUpgradedEnough(controller: StructureController) {
  if (controller.progressTotal) return false;
  if (countUpgradersAssigned(controller.id) > 0) return true;
  if (controller.ticksToDowngrade > 100000) return true;
  return false;
}

function countUpgradersAssigned(controllerId: Id<StructureController>) {
  return Object.values(Game.creeps).filter(creep => creep.memory.upgrade === controllerId).length;
}

function moveTowardMemory(creep: Creep) {
  utils.logCpu("moveTowardMemory(" + creep.name + ")");
  let destination: Destination = Game.flags["creep_" + creep.name];
  if (!destination) {
    const destinationMemory = creep.memory.destination;
    if (typeof destinationMemory === "string") {
      const destinationObject = Game.getObjectById(destinationMemory);
      if (destinationObject) destination = destinationObject;
    }
  }
  if (destination) {
    move(creep, destination);
    if (utils.getGlobalRange(creep.pos, destination.pos) <= 1) utils.resetDestination(creep);
    utils.logCpu("moveTowardMemory(" + creep.name + ")");
    return true;
  }
  utils.logCpu("moveTowardMemory(" + creep.name + ")");
  return false;
}

function handleCarrier(creep: Creep) {
  utils.logCpu("handleCarrier(" + creep.name + ")");
  if (Math.random() < 0.1 && gotSpareCpu() && !isCarrierPlanValid(creep)) {
    utils.msg(creep, "Plan is invalid, replanning");
    planCarrierRoutes(creep);
  } else if (isStuck(creep)) {
    moveRandomDirection(creep);
    return;
  }
  if (!creep.memory.phases || creep.memory.phases.length < 2) planCarrierRoutes(creep);
  if (!creep.memory.phases) return;
  const phase = creep.memory.phases[creep.memory.phaseIndex || 0];
  if (phase.move) phaseMove(creep, phase);
  else if (phase.retrieve) phaseRetrieve(creep, phase);
  else if (phase.transfer) phaseTransfer(creep, phase);
  utils.logCpu("handleCarrier(" + creep.name + ")");
}

function phaseMove(creep: Creep, phase: Phase) {
  if (!creep.memory.phases) return;
  if (!phase.move) return;
  const path = phase.move.map(pos => new RoomPosition(pos.x, pos.y, pos.roomName));
  if (creep.memory.debug)
    utils.msg(
      creep,
      "Following a path from " + path[0].toString() + " to " + path[path.length - 1].toString()
    );
  const outcome = creep.moveByPath(path);
  if (outcome === ERR_NOT_FOUND) {
    const end = path[path.length - 1];
    if (isPosEqual(creep.pos, end)) {
      nextPhase(creep);
    } else {
      const tgt = creep.pos.findClosestByRange(path);
      if (!tgt) return;
      move(creep, tgt);
    }
  } else if (outcome === OK) {
    if (isStuck(creep)) {
      nextPhase(creep); // switch to dynamic navigation to get unstuck
    } else if (creep.room.memory.hostilesPresent) {
      utils.msg(creep, "hostiles present, resetting plans");
      delete creep.memory.phases;
    }
  }
}

function isStuck(creep: Creep) {
  return (creep.memory.lastMoveTime || 0) < Game.time - 10;
}

function phaseRetrieve(creep: Creep, phase: Phase) {
  if (!creep.memory.phases) return;
  if (!phase.retrieve) return;
  const tgt = Game.getObjectById(phase.retrieve);
  if (!tgt) {
    utils.msg(
      creep,
      "Trying to retrieve from " + phase.retrieve + ", but it doesn't exist! Resetting plans!"
    );
    delete creep.memory.phases;
    delete creep.memory.phaseIndex;
    return;
  }
  if (creep.memory.debug) utils.msg(creep, "Retrieving energy from " + utils.getObjectDescription(tgt));
  const outcome = retrieveEnergy(creep, tgt);
  if (outcome === ERR_NOT_IN_RANGE) {
    move(creep, tgt);
  } else {
    nextPhase(creep);
  }
}

function phaseTransfer(creep: Creep, phase: Phase) {
  if (!creep.memory.phases) return;
  if (!phase.transfer) return;
  if (creep.memory.transferred) return;
  const tgt = Game.getObjectById(phase.transfer);
  if (!tgt) {
    utils.msg(creep, "Trying to transfer to " + phase.transfer + ", but it doesn't exist! Resetting plans!");
    delete creep.memory.phases;
    delete creep.memory.phaseIndex;
    return;
  }
  if (creep.memory.debug) utils.msg(creep, "Transfering energy to " + utils.getObjectDescription(tgt));
  const outcome = transfer(creep, tgt);
  if (outcome === ERR_NOT_IN_RANGE) {
    move(creep, tgt);
  } else {
    creep.memory.transferred = true;
    nextPhase(creep);
  }
}

function nextPhase(creep: Creep) {
  if (!creep.memory.phases) return;
  if (creep.memory.debug) utils.msg(creep, "Next phase");
  const typeBefore = Object.keys(creep.memory.phases[creep.memory.phaseIndex || 0])[0];
  creep.memory.phaseIndex = ((creep.memory.phaseIndex || 0) + 1) % creep.memory.phases.length;
  const typeAfter = Object.keys(creep.memory.phases[creep.memory.phaseIndex || 0])[0];
  // different types can be executed same tick
  if (typeBefore !== typeAfter) handleCarrier(creep);
}

function getReserverForClaiming() {
  return Object.values(Game.creeps)
    .filter(creep => creep.memory.role === "reserver")
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
  } else if (creep.memory.action === "recycleCreep" || creep.room.memory.hostilesPresent) {
    recycleCreep(creep);
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
    const destinations = Memory.plan?.controllersToReserve.map(id => Game.getObjectById(id));
    if (destinations.length && destinations[0]) {
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
  if (utils.isEmpty(creep)) {
    if (retrieveEnergy(creep, upstream, true) === ERR_NOT_IN_RANGE) move(creep, upstream);
  } else {
    const workers = creep.pos
      .findInRange(FIND_MY_CREEPS, 1)
      .filter(
        worker =>
          (worker.memory.role === "worker" || worker.memory.role === "upgrader") &&
          utils.getFillRatio(worker) < 0.5
      );
    for (const worker of workers) creep.transfer(worker, RESOURCE_ENERGY);
    if (creep.transfer(downstream, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) move(creep, downstream);
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
  if (actionOutcome === OK) utils.resetSpecificDestinationFromCreeps(destination);
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

function handleAttacker(creep: Creep) {
  utils.logCpu("handleAttacker(" + creep.name + ")");
  const flag = Game.flags.attack;
  const bestTarget = utils.getTarget(creep, undefined);
  if (!flag && !bestTarget) {
    recycleCreep(creep);
  } else if (bestTarget) {
    if (creep.attack(bestTarget) === ERR_NOT_IN_RANGE) {
      move(creep, bestTarget);
      creep.attack(bestTarget);
    }
  } else if (flag) {
    move(creep, flag);
  }
  utils.logCpu("handleAttacker(" + creep.name + ")");
}

function handleInfantry(creep: Creep) {
  utils.logCpu("handleInfantry(" + creep.name + ")");
  const flag = Game.flags.attack;
  const bestTarget = utils.getTarget(creep, undefined);
  if (!flag && !bestTarget) {
    recycleCreep(creep);
  } else if (bestTarget) {
    if (creep.rangedAttack(bestTarget) === ERR_NOT_IN_RANGE || bestTarget instanceof Structure) {
      move(creep, bestTarget);
      creep.rangedAttack(bestTarget);
    } else {
      evadeHostiles(creep);
    }
  } else if (flag) {
    move(creep, flag);
  }
  utils.logCpu("handleInfantry(" + creep.name + ")");
}

function evadeHostiles(creep: Creep) {
  utils.logCpu("evadeHostiles(" + creep.name + ")");
  const hostilePositions = creep.pos
    .findInRange(FIND_HOSTILE_CREEPS, 4)
    .map(hostile => hostile.pos)
    .concat(creep.pos.findInRange(FIND_HOSTILE_POWER_CREEPS, 4).map(hostile => hostile.pos));
  if (hostilePositions.length < 1) return;
  const options = utils.getPositionsAround(creep.pos, 1, 1, true);
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
  utils.logCpu("evadeHostiles(" + creep.name + ")");
}

function recycleCreep(creep: Creep) {
  creep.say("♻️");
  creep.memory.action = "recycleCreep";
  let destination;
  const oldDestination = creep.memory.destination;
  if (typeof oldDestination === "string") destination = Game.getObjectById(oldDestination);
  if (!(destination instanceof StructureSpawn)) destination = utils.resetDestination(creep);

  if (!destination || !(destination instanceof StructureSpawn)) {
    const spawns = Object.values(Game.spawns);

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
    } else {
      move(creep, destination);
    }
  }
}

function handleHarvester(creep: Creep) {
  utils.logCpu("handleHarvester(" + creep.name + ")");
  if (creep.memory.role !== "harvester") return false;
  if (creep.spawning) return true;
  const flagName = "creep_" + creep.name;
  if (
    !creep.memory.sourceId ||
    creep.memory.action === "recycleCreep" ||
    creep.room.memory.hostilesPresent ||
    !(flagName in Game.flags) ||
    (Game.flags[flagName].room && Game.flags[flagName].pos.findInRange(FIND_SOURCES, 1).length < 1)
  ) {
    recycleCreep(creep);
    return true;
  }
  // move
  const flag = Game.flags[flagName];
  if (!isPosEqual(creep.pos, flag.pos)) move(creep, flag);
  if (!utils.isEmpty(creep)) harvesterSpendEnergy(creep);
  // harvest
  const sourceId = creep.memory.sourceId;
  if (sourceId) {
    const source = Game.getObjectById(sourceId);
    if (source) {
      const outcome = creep.harvest(source);
      if (outcome === ERR_NOT_OWNER) creep.memory.action = "recycleCreep";
    }
  }
  // done
  utils.logCpu("handleHarvester(" + creep.name + ")");
  return true;
}

function harvesterSpendEnergy(creep: Creep) {
  utils.logCpu("harvesterSpendEnergy(" + creep.name + ")");
  if (
    creep.pos.findInRange(FIND_MY_CREEPS, 10).filter(nearbyCreep => nearbyCreep.memory.role === "worker")
      .length < 1
  ) {
    const target = creep.pos.lookFor(LOOK_STRUCTURES).filter(utils.needRepair)[0];
    if (target) creep.repair(target);
    const site = creep.pos.lookFor(LOOK_CONSTRUCTION_SITES)[0];
    if (site) creep.build(site);
  }
  utils.logCpu("harvesterSpendEnergy(" + creep.name + ") unloadCreep");
  if (utils.getFillRatio(creep) > 0.9) {
    const storeId = creep.memory.link || creep.memory.container;
    let store;
    if (storeId) store = Game.getObjectById(storeId);
    if (!store) {
      const sourceId = creep.memory.sourceId;
      if (!sourceId) return;
      const source = Game.getObjectById(sourceId);
      if (!source) return;
      store = source.pos.findClosestByRange(FIND_STRUCTURES, {
        filter(object) {
          return utils.isLink(object) || utils.isContainer(object);
        }
      });
      if (!store) return;
      if (utils.isLink(store)) creep.memory.link = store.id;
      else if (utils.isContainer(store)) creep.memory.container = store.id;
    }
    if (creep.transfer(store, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) move(creep, store);
  }
  utils.logCpu("harvesterSpendEnergy(" + creep.name + ") unloadCreep");
  utils.logCpu("harvesterSpendEnergy(" + creep.name + ")");
}

function handleRoom(room: Room) {
  utils.logCpu("handleRoom(" + room.name + ")");
  utils.logCpu("handleRoom(" + room.name + ") costs");
  if (!room.memory.costMatrix || Math.random() < 0.03)
    room.memory.costMatrix = getCostMatrix(room.name).serialize();
  utils.logCpu("handleRoom(" + room.name + ") costs");
  utils.logCpu("handleRoom(" + room.name + ") towers");
  handleRoomTowers(room);
  utils.logCpu("handleRoom(" + room.name + ") towers");
  utils.logCpu("handleRoom(" + room.name + ") observers");
  if (Math.random() < 0.1 && gotSpareCpu()) handleRoomObservers(room);
  utils.logCpu("handleRoom(" + room.name + ") observers");
  utils.logCpu("handleRoom(" + room.name + ") updates1");
  utils.handleHostilesInRoom(room);
  if (utils.canOperateInRoom(room) && Math.random() < 0.3 && gotSpareCpu()) utils.constructInRoom(room);
  utils.logCpu("handleRoom(" + room.name + ") updates1");
  utils.logCpu("handleRoom(" + room.name + ") updates2");
  utils.handleLinks(room);
  roomUpdates(room);
  utils.logCpu("handleRoom(" + room.name + ") updates2");
  utils.logCpu("handleRoom(" + room.name + ") updates3");
  utils.checkRoomCanOperate(room);
  if (Math.random() < 0.1 && gotSpareCpu()) updateStickyEnergy(room);
  utils.logCpu("handleRoom(" + room.name + ") updates3");
  utils.logCpu("handleRoom(" + room.name + ")");
}

function handleRoomTowers(room: Room) {
  utils.logCpu("handleRoomTowers(" + room.name + ")");
  const towers = room.find(FIND_MY_STRUCTURES).filter(utils.isTower);
  for (const t of towers) {
    const creep = t.pos.findClosestByRange(FIND_HOSTILE_CREEPS);
    if (creep) {
      utils.engageTarget(t, creep);
      continue;
    }
    const powerCreep = t.pos.findClosestByRange(FIND_HOSTILE_POWER_CREEPS);
    if (powerCreep) {
      utils.engageTarget(t, powerCreep);
      continue;
    }
  }
  utils.logCpu("handleRoomTowers(" + room.name + ")");
}

function handleRoomObservers(room: Room) {
  utils.logCpu("handleRoomObservers(" + room.name + ")");
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
          utils.logCpu("handleRoomObservers(" + room.name + ")");
          return;
        }
      }
    }
  }
  utils.logCpu("handleRoomObservers(" + room.name + ")");
}

function roomUpdates(room: Room) {
  utils.logCpu("roomUpdates(" + room.name + ")");
  delete room.memory.upgradeSpots;
  if (!room.memory.harvestSpots) utils.updateHarvestSpots(room);
  if (!room.memory.remoteHarvestScore) utils.updateRemoteHarvestScore(room);
  if (!room.memory.score) utils.updateRoomScore(room);
  if (Math.random() < 0.001) utils.updateRoomRepairTargets(room);
  utils.logCpu("roomUpdates(" + room.name + ")");
}

function move(creep: Creep, destination: Destination, safe = true) {
  utils.logCpu("move(" + creep.name + ")");
  utils.logCpu("move(" + creep.name + ") moveTo");
  const options: MoveToOpts = {
    // bit of randomness to prevent creeps from moving the same way at same time to pass each other
    reusePath: Math.round(Memory.maxTickLimit - Game.cpu.tickLimit + Math.random()),
    visualizePathStyle: {
      stroke: creep.memory.stroke,
      opacity: 0.6,
      lineStyle: "dotted",
      strokeWidth: creep.memory.strokeWidth
    },
    plainCost: 2,
    swampCost: 10
  };
  if (safe) options.costCallback = getCostMatrixSafe;
  const outcome = creep.moveTo(destination, options);
  utils.logCpu("move(" + creep.name + ") moveTo");
  utils.logCpu("move(" + creep.name + ")");
  return outcome;
}

function hslToHex(h: number /* deg */, s: number /* % */, l: number /* % */) {
  //  https://stackoverflow.com/a/44134328
  //  hslToHex(360, 100, 50)  // "#ff0000" -> red
  l /= 100;
  const a = (s * Math.min(l, 1 - l)) / 100;
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const color = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    return Math.round(255 * color)
      .toString(16)
      .padStart(2, "0"); // convert to Hex and prefix "0" if needed
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

function withdraw(creep: Creep, destination: Destination) {
  if (destination instanceof Structure || destination instanceof Tombstone || destination instanceof Ruin) {
    const actionOutcome = creep.withdraw(destination, RESOURCE_ENERGY);
    if (actionOutcome === OK) utils.resetSpecificDestinationFromCreeps(destination);
    return actionOutcome;
  }
  return ERR_INVALID_TARGET;
}

function pickup(creep: Creep, destination: Destination) {
  if (destination instanceof Resource) {
    const actionOutcome = creep.pickup(destination);
    if (actionOutcome === OK) utils.resetSpecificDestinationFromCreeps(destination);
    return actionOutcome;
  }
  return ERR_INVALID_TARGET;
}

function gotSpareCpu() {
  return Game.cpu.tickLimit >= Memory.maxTickLimit && Memory.cpuUsedRatio < 0.9;
}

function spawnCreeps() {
  utils.logCpu("spawnCreeps()");
  const budget = gotSpareCpu() ? Memory.plan?.maxRoomEnergy : Memory.plan?.maxRoomEnergyCap;
  if (Memory.plan?.minTicksToDowngrade < 1000) {
    const upgradeTarget = getControllerToUpgrade();
    if (!upgradeTarget || countUpgradersAssigned(upgradeTarget.id) > 0) return;
    spawnCreep("upgrader", budget, undefined, undefined, upgradeTarget);
  } else if (Memory.plan?.needTransferers) {
    spawnTransferer();
  } else if (Memory.plan?.needCarriers) {
    spawnCreep("carrier", budget);
  } else if (Memory.plan?.needHarvesters) {
    spawnHarvester();
  } else if (Memory.plan?.needInfantry) {
    spawnRole("infantry");
  } else if (Memory.plan?.needAttackers) {
    spawnCreep("attacker", budget);
  } else if (Memory.plan?.needExplorers) {
    spawnRole("explorer", 0, [MOVE]);
  } else if (Memory.plan?.needWorkers) {
    spawnCreep("worker", budget);
  } else if (Memory.plan?.needReservers && budget >= utils.getBodyCost(["claim", "move"])) {
    spawnReserver();
  } else if (Memory.plan?.needUpgraders) {
    const upgradeTarget = getControllerToUpgrade();
    if (!upgradeTarget) return;
    spawnCreep("upgrader", budget, undefined, undefined, upgradeTarget);
  }
  utils.logCpu("spawnCreeps()");
}

function needReservers() {
  return (
    Memory.plan?.controllersToReserve.length > 0 ||
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

  const controlledRooms = Object.values(Game.rooms).filter(room => room.controller && room.controller.my);
  if (controlledRooms.length >= Game.gcl.level) return;

  const bestRoomName = getRoomToClaim(controlledRooms);

  if (!bestRoomName) return;
  if (!(bestRoomName in Game.rooms)) return;
  const controller = Game.rooms[bestRoomName].controller;
  if (!controller) return;
  utils.msg(controller, "Flagging room " + bestRoomName + " to be claimed!", true);
  controller.pos.createFlag("claim", COLOR_WHITE, COLOR_BLUE);
}

function getRoomToClaim(controlledRooms: Room[]) {
  let bestScore = Number.NEGATIVE_INFINITY;
  let bestRoomName;

  for (const room of controlledRooms) {
    if (!room.controller) continue;
    if (!room.controller.my) continue;
    const exits = Game.map.describeExits(room.name);
    const accessibleRoomNames = Object.values(exits).filter(
      roomName =>
        utils.isRoomSafe(roomName) &&
        Memory.rooms[roomName]?.canOperate &&
        utils.getRoomStatus(roomName) === utils.getRoomStatus(room.name)
    );
    for (const nearRoomName of accessibleRoomNames) {
      if (controlledRooms.filter(controlledRoom => controlledRoom.name === nearRoomName).length > 0) continue;
      const score = Memory.rooms[nearRoomName].score;
      if (bestScore < score) {
        bestScore = score;
        bestRoomName = nearRoomName;
      }
    }
  }
  return bestRoomName;
}

function needCarriers(): boolean {
  utils.logCpu("needCarriers()");
  if (getStoragesRequiringCarrier().length > 0) return true;
  for (const room of Object.values(Game.rooms)) {
    if (room.memory.hostilesPresent || !room.memory.canOperate) continue;
    const sources = room.find(FIND_SOURCES);
    for (const source of sources) {
      const containers = source.pos.findInRange(FIND_STRUCTURES, 3).filter(utils.isContainer);
      for (const container of containers) {
        const energy = room.memory.stickyEnergy?.[container.id] || 0;
        const delta = room.memory.stickyEnergyDelta?.[container.id] || 0;
        const assignedCapacity = getCarryCapacityBySource(container.id) || 0;
        if (energy > assignedCapacity && delta >= 0) {
          utils.logCpu("needCarriers()");
          return true;
        }
      }
    }
  }
  utils.logCpu("needCarriers()");
  return false;
}

function needTransferers(): boolean {
  // we have storages without transferrer, next to link that has energy
  utils.logCpu("needTransferers()");
  const value =
    Object.values(Game.structures)
      .filter(utils.isStorage)
      .filter(
        storage =>
          Object.values(Game.creeps).filter(
            creep => creep.memory.role === "transferer" && creep.memory.transferTo === storage.id
          ).length <= 0 &&
          storage.pos
            .findInRange(FIND_MY_STRUCTURES, 2)
            .filter(utils.isLink)
            .filter(link => utils.getEnergy(link) > 0).length > 0
      ).length > 0;
  utils.logCpu("needTransferers()");
  return value;
}

function spawnRole(roleToSpawn: Role, minBudget = 0, body: undefined | BodyPartConstant[] = undefined) {
  const budget = Math.floor(
    Math.min(
      Math.max(utils.getCostOfCurrentCreepsInTheRole(roleToSpawn), minBudget),
      Memory.plan?.maxRoomEnergyCap
    )
  );
  spawnCreep(roleToSpawn, budget, body, undefined);
}

function needInfantry() {
  if (!("attack" in Game.flags)) return false;
  return Memory.rooms[Game.flags.attack.pos.roomName].hostileRangedAttackParts > 0;
}

function needAttackers() {
  return "attack" in Game.flags && utils.getCreepCountByRole("attacker") < 5;
}

function spawnReserver() {
  let task: Task | undefined;
  const controller =
    Game.getObjectById(Memory.plan?.controllersToReserve[0]) || Game.flags.claim.room?.controller;
  if (controller) {
    task = {
      destination: controller,
      action: "reserveController"
    };
  }
  const energy = Math.min(Memory.plan?.maxRoomEnergy, 3800);
  spawnCreep("reserver", energy, undefined, task);
}

function getDestructibleWallAt(pos: RoomPosition) {
  const walls = pos.lookFor(LOOK_STRUCTURES).filter(utils.isDestructibleWall);
  if (walls.length && walls[0].destroy() === ERR_NOT_OWNER) return walls[0];
  return;
}

function updateFlagAttack() {
  utils.logCpu("updateFlagAttack()");
  const flagAttack = Game.flags.attack;
  if (flagAttack) {
    if (
      flagAttack.room &&
      !getDestructibleWallAt(flagAttack.pos) &&
      getTargetsInRoom(flagAttack.room).length < 1
    ) {
      flagAttack.remove(); // have visibility to the room and it's clear of hostiles
    } else {
      utils.logCpu("updateFlagAttack()");
      return; // current flag is still valid (to the best of our knowledge)
    }
  }
  // no flag, find new targets
  utils.logCpu("updateFlagAttack() new");
  let targets: (Structure | Creep | PowerCreep)[] = [];
  for (const r in Game.rooms) {
    const controller = Game.rooms[r].controller;
    if (!controller) continue;
    if (!controller.my) continue;
    if (!utils.isReservationOk(controller)) continue;
    utils.logCpu("updateFlagAttack() targets");
    targets = targets.concat(getTargetsInRoom(Game.rooms[r]));
    utils.logCpu("updateFlagAttack() targets");
  }
  const target = targets[Math.floor(Math.random() * targets.length)];
  if (target) {
    target.pos.createFlag("attack", COLOR_RED, COLOR_BROWN);
    utils.msg(target, "attack: " + utils.getObjectDescription(target));
  }
  utils.logCpu("updateFlagAttack() new");
  utils.logCpu("updateFlagAttack()");
}

function updateFlagDismantle() {
  utils.logCpu("updateFlagDismantle()");
  const flagDismantle = Game.flags.dismantle;
  if (flagDismantle) {
    if (flagDismantle.room && flagDismantle.pos.lookFor(LOOK_STRUCTURES).length < 1) {
      flagDismantle.remove(); // have visibility to the room and it's clear of hostiles
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
        utils.logCpu("updateFlagDismantle()");
        return;
      }
    }
  }
  utils.logCpu("updateFlagDismantle()");
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
  utils.logCpu("getWallToDestroy(" + room.name + ")");
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
        utils.logCpu("getWallToDestroy(" + room.name + ")");
        if (wall && wall.destroy() === ERR_NOT_OWNER) return wall;
      }
    }
  }
  utils.logCpu("getWallToDestroy(" + room.name + ")");
  return;
}

function updateFlagReserve() {
  utils.logCpu("updateFlagReserve()");
  const flagReserve = Game.flags.reserve;
  if (flagReserve) {
    if (flagReserve.room && !utils.shouldReserveRoom(flagReserve.room)) {
      flagReserve.remove();
    } else {
      utils.logCpu("updateFlagReserve()");
      return; // current flag is still valid
    }
  }
  const targets = Memory.plan?.controllersToReserve.map(id => Game.getObjectById(id));
  if (targets?.length && targets[0]) {
    targets[0].pos.createFlag("reserve", COLOR_ORANGE, COLOR_WHITE);
  }
  utils.logCpu("updateFlagReserve()");
}

function needWorkers() {
  utils.logCpu("needWorkers");
  if (utils.isAnyoneIdle("worker")) return false;
  const workers = Object.values(Game.creeps).filter(creep => creep.memory.role === "worker");
  utils.logCpu("needWorkers");
  if (workers.length >= 15) return false;
  const workParts = workers.reduce(
    (aggregated, item) => aggregated + item.getActiveBodyparts(WORK),
    0 /* initial*/
  );
  const partsNeeded = Math.ceil(getTotalConstructionWork() / 400 + utils.getTotalRepairTargetCount() / 1.5);
  const value =
    partsNeeded > workParts && (Memory.plan?.minTicksToDowngrade > 4000 || !Memory.plan?.needUpgraders);
  utils.logCpu("needWorkers");
  return value;
}

function getTotalConstructionWork() {
  return Object.values(Game.constructionSites)
    .filter(site => site.room && utils.isRoomSafe(site.room.name))
    .reduce((aggregated, item) => aggregated + item.progressTotal - item.progress, 0 /* initial*/);
}

function getSourceToHarvest() {
  utils.logCpu("getSourceToHarvest()");
  let sources: Source[] = [];
  for (const r in Game.rooms) {
    const room = Game.rooms[r];
    if (room.memory.hostilesPresent) continue;
    if (!utils.canOperateInRoom(room)) continue;
    if (!utils.shouldHarvestRoom(room)) continue;
    sources = sources.concat(
      room.find(FIND_SOURCES).filter(harvestSource => !utils.sourceHasHarvester(harvestSource))
    );
  }
  utils.logCpu("getSourceToHarvest()");
  if (sources.length < 1) return;
  const source = sources
    .map(value => ({ value, sort: value.energy + value.energyCapacity })) /* persist sort values */
    .sort((a, b) => b.sort - a.sort) /* sort */
    .map(({ value }) => value) /* remove sort values */[0];
  utils.logCpu("getSourceToHarvest()");
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
  const harvestPos = utils.getHarvestSpotForSource(source);
  if (!harvestPos) return;
  utils.constructContainerIfNeed(harvestPos);
  const memory = {
    role: roleToSpawn,
    sourceId: source.id,
    stroke: hslToHex(Math.random() * 360, 100, 50),
    strokeWidth: 0.1 + 0.1 * (Math.random() % 4),
    pos: spawn.pos
  };
  if (spawn.spawnCreep(body, name, { memory }) === OK) {
    utils.setDestinationFlag(name, harvestPos);
    utils.spawnMsg(spawn, roleToSpawn, name, body, utils.getObjectDescription(harvestPos));
  }
  return true;
}

function spawnTransferer() {
  const roleToSpawn: Role = "transferer";
  const storages = Object.values(Game.structures)
    .filter(utils.isStorage)
    .filter(
      storage =>
        utils.hasStructureInRange(storage.pos, STRUCTURE_LINK, 2, false) &&
        Object.values(Game.creeps).filter(
          creep => creep.memory.role === roleToSpawn && creep.memory.transferTo === storage.id
        ).length <= 0
    );
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
  if (
    spawn.spawnCreep(body, name, {
      memory: getTransferrerMem(link.id, tgtStorage.id, spawn.pos)
    }) === OK
  ) {
    utils.spawnMsg(spawn, roleToSpawn, name, body, utils.getObjectDescription(tgtStorage));
  }
  return true;
}

function getTransferrerMem(retrieve: Id<StructureLink>, transferTo: Id<StructureStorage>, pos: RoomPosition) {
  return {
    retrieve,
    role: "transferer" as Role,
    transferTo,
    stroke: hslToHex(Math.random() * 360, 100, 50),
    strokeWidth: 0.1 + 0.1 * (Math.random() % 4),
    pos
  };
}

function getSpawn(energyRequired: number, targetPos: RoomPosition | undefined) {
  return Object.values(Game.spawns)
    .filter(spawn => spawn.room.energyAvailable >= energyRequired && !spawn.spawning)
    .map(value => ({
      value,
      sort: targetPos
        ? utils.getGlobalRange(value.pos, targetPos)
        : Math.random() - value.room.energyAvailable
    })) /* persist sort values */
    .sort((a, b) => a.sort - b.sort) /* sort */
    .map(({ value }) => value) /* remove sort values */[0];
}

function spawnCreep(
  roleToSpawn: Role,
  energyAvailable: number,
  body: undefined | BodyPartConstant[] = undefined,
  task: Task | undefined = undefined,
  upgradeTarget: StructureController | undefined = undefined
) {
  if (!body) body = getBody(roleToSpawn, energyAvailable);
  const name = utils.getNameForCreep(roleToSpawn);
  const spawn = getSpawn(energyAvailable, utils.getPos(task?.destination));
  if (!spawn) return;
  if (!body || utils.getBodyCost(body) > spawn.room.energyAvailable) return;

  const outcome = spawn.spawnCreep(body, name, {
    memory: getInitialCreepMem(roleToSpawn, task, spawn.pos, upgradeTarget)
  });

  if (outcome === OK) {
    const target = task?.destination || upgradeTarget;
    utils.spawnMsg(spawn, roleToSpawn, name, body, utils.getObjectDescription(target));
  } else {
    utils.msg(spawn, "Failed to spawn creep: " + outcome.toString());
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
    role: roleToSpawn,
    stroke: hslToHex(Math.random() * 360, 100, 50),
    strokeWidth: 0.1 + 0.1 * (Math.random() % 4),
    upgrade: upgradeTarget?.id
  };
}

function getBody(roleToSpawn: Role, energyAvailable: number) {
  if (roleToSpawn === "attacker") return getBodyForAttacker(energyAvailable);
  else if (roleToSpawn === "carrier") return getBodyForCarrier(energyAvailable);
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

function getBodyForAttacker(energyAvailable: number) {
  const body: BodyPartConstant[] = [ATTACK, MOVE];
  for (;;) {
    const nextPart = utils.getBodyPartRatio(body) <= 0.34 ? MOVE : ATTACK;
    if (utils.getBodyCost(body) + BODYPART_COST[nextPart] > energyAvailable) return body;
    body.push(nextPart);
    if (body.length >= 50) return body;
  }
}

function getBodyForInfantry(energyAvailable: number) {
  const body: BodyPartConstant[] = [MOVE, RANGED_ATTACK];
  for (;;) {
    const nextPart = utils.getBodyPartRatio(body) <= 0.34 ? MOVE : RANGED_ATTACK;
    if (utils.getBodyCost(body) + BODYPART_COST[nextPart] > energyAvailable) return body;
    body.push(nextPart);
    if (body.length >= 50) return body;
  }
}

function purgeFlagsMemory() {
  utils.logCpu("purgeFlagsMemory()");
  for (const key in Memory.flags) {
    if (!Game.flags[key]) delete Memory.flags[key];
  }
  utils.logCpu("purgeFlagsMemory()");
}

function purgeFlags() {
  utils.logCpu("purgeFlags()");
  for (const flag of Object.values(Game.flags)) {
    const name = flag.name;
    if (name.startsWith("traffic_")) flag.remove();
    if (name.startsWith("creep_") && !(name.substring(6) in Game.creeps)) flag.remove();
  }
  utils.logCpu("purgeFlags()");
}

function isPosEqual(a: RoomPosition, b: RoomPosition) {
  if (!a || !b) return false;
  if (a.x !== b.x) return false;
  if (a.y !== b.y) return false;
  if (a.roomName !== b.roomName) return false;
  return true;
}

function planCarrierRoutes(creep: Creep) {
  creep.memory.phaseIndex = 0;
  const source = getCarrierEnergySource(creep);
  console.log(creep, "retrieving", source, source.pos);
  if (!source) return;
  else if (utils.isContainer(source)) creep.memory.container = source.id;
  else if (utils.isStorage(source)) creep.memory.storage = source.id;
  creep.memory.phases = [{ retrieve: source.id }];
  let pos = source.pos;
  let firstPos;
  let energy = creep.store.getCapacity(RESOURCE_ENERGY);
  let clusters = getClusters();
  if (clusters.length < 1) {
    utils.msg(creep, "Couldn't find clusters for carrier!", true);
  }
  while (energy > 0 && clusters.length) {
    clusters = sortClusters(clusters, pos);
    const targetAdded = addCarrierDestination(creep, pos, clusters.shift());
    if (targetAdded) {
      if (!firstPos) firstPos = targetAdded.firstPos;
      pos = targetAdded.pos;
      energy -= targetAdded.energy;
    }
  }
  const storageAdded = addCarrierDestinationStorage(creep, source, pos);
  if (storageAdded) {
    if (!firstPos) firstPos = storageAdded.firstPos;
    pos = storageAdded.pos;
    energy -= storageAdded.energy;
  }
  if (!firstPos) return;
  const returnPath = getPath(pos, firstPos, 0);
  if (returnPath.length > 0) creep.memory.phases.push({ move: returnPath });
  if (utils.getConstructionSites().length <= 0) buildRoadsForCarrier(creep);
}

function addCarrierDestinationStorage(
  creep: Creep,
  source: StructureContainer | StructureStorage,
  pos: RoomPosition
) {
  if (!creep) return;
  if (!creep.memory.phases) return;
  const room = Game.rooms[pos.roomName];
  if (utils.getStructureCount(room, STRUCTURE_LINK, false) < 2 && room?.controller?.my) {
    // fill storage/container near controller without links
    const storage = getStorage(room);
    if (storage && utils.isStoreStructure(storage) && storage.id !== source.id) {
      const path = getPath(pos, storage.pos, 1);
      let firstPos;
      if (path.length > 0) {
        firstPos = path[0];
        creep.memory.phases.push({ move: path });
        pos = path[path.length - 1];
      }
      creep.memory.phases.push({ transfer: storage.id });
      // target structures are often full, so only decrease some energy
      const energy = storage.store.getCapacity(RESOURCE_ENERGY) / 2;
      return { firstPos, pos, energy };
    }
  }
  return;
}

function addCarrierDestination(
  creep: Creep,
  pos: RoomPosition,
  destination:
    | {
        pos: RoomPosition;
        carriers: number;
        towersLowOnEnergy: number;
      }
    | undefined
) {
  if (!creep) return;
  if (!creep.memory.phases) return;
  if (!destination) return;
  const path = getPath(pos, destination.pos, 0);
  let firstPos;
  if (path.length > 0) {
    firstPos = path[0];
    creep.memory.phases.push({ move: path });
    pos = path[path.length - 1];
  }
  const structures = getClusterStructures(destination.pos);
  let energy = 0;
  for (const target of structures) {
    creep.memory.phases.push({ transfer: target.id });
    // target structures are often full, so only decrease some energy
    if (!utils.isTower(target) && "store" in target) energy += target.store.getCapacity(RESOURCE_ENERGY) / 2;
  }
  return { firstPos, pos, energy };
}

function getStorage(room: Room) {
  if (room.controller) {
    return room.controller.pos.findClosestByRange(
      room.controller.pos.findInRange(FIND_STRUCTURES, 10, {
        filter(object) {
          return utils.isStorage(object) || utils.isStorageSubstitute(object);
        }
      })
    );
  }
  return;
}

function sortClusters(
  clusters: { pos: RoomPosition; carriers: number; towersLowOnEnergy: number }[],
  pos: RoomPosition
) {
  clusters = clusters
    .map(value => ({
      value,
      sort: utils.getGlobalRange(pos, value.pos) + value.carriers * 50 - value.towersLowOnEnergy * 50
    })) /* persist sort values */
    .sort((a, b) => a.sort - b.sort) /* sort */
    .map(({ value }) => value) /* remove sort values */;
  return clusters;
}

function getClusterStructures(clusterPos: RoomPosition) {
  const structures = clusterPos
    .findInRange(FIND_MY_STRUCTURES, 1)
    .map(value => ({
      value,
      sort: Math.random()
    })) /* persist sort values */
    .sort((a, b) => a.sort - b.sort) /* sort */
    .map(({ value }) => value) /* remove sort values */
    .filter(utils.isOwnedStoreStructure);
  return structures;
}

function getClusters() {
  return Object.values(Game.flags)
    .filter(
      flag =>
        flag.name.startsWith("cluster_") &&
        flag.room &&
        flag.pos.findInRange(FIND_MY_STRUCTURES, 1).length > 0
    )
    .map(flag => ({
      pos: flag.pos,
      carriers: countCarriersByCluster(flag.pos),
      towersLowOnEnergy: flag.pos
        .findInRange(FIND_MY_STRUCTURES, 1)
        .filter(utils.isTower)
        .filter(tower => utils.getFillRatio(tower) < 0.5).length
    }));
}

function getPath(from: RoomPosition, to: RoomPosition, range: number) {
  return PathFinder.search(
    from,
    { pos: to, range },
    {
      plainCost: 2,
      swampCost: 10,
      roomCallback: getCostMatrixSafe
    }
  ).path;
}

function getCarrierEnergySource(creep: Creep) {
  let containers: (StructureContainer | StructureStorage)[] = getStoragesRequiringCarrier();
  if (containers.length < 1) {
    for (const room of Object.values(Game.rooms)) {
      if (room.memory.hostilesPresent) continue;
      containers = containers.concat(
        room
          .find(FIND_STRUCTURES)
          .filter(utils.isContainer)
          .filter(container => !utils.isStorageSubstitute(container))
      );
    }
  }
  return containers
    .map(value => ({
      value,
      sort:
        utils.getFillRatio(value) /
        (Object.values(Game.creeps).filter(
          carrier =>
            carrier.memory.role === "carrier" &&
            carrier.memory.phases &&
            carrier.memory.phases.map(phase => phase.retrieve || "").includes(value.id)
        ).length || 0.1) /
        (utils.getGlobalRange(creep.pos, value.pos) / 100)
    })) /* persist sort values */
    .sort((a, b) => b.sort - a.sort) /* sort */
    .map(({ value }) => value) /* remove sort values */[0];
}

function getStoragesRequiringCarrier() {
  const containers: StructureStorage[] = [];
  for (const room of Object.values(Game.rooms)) {
    if (room.storage && room.storage.my) {
      const carriersForStorage = Math.ceil(
        (room.memory.stickyEnergy?.[room.storage.id] / STORAGE_CAPACITY) * 4
      );
      if (countCarriersBySource(room.storage.id) < carriersForStorage) containers.push(room.storage);
    }
  }
  return containers;
}

function getCostMatrix(roomName: string) {
  const room = Game.rooms[roomName];
  const costs = new PathFinder.CostMatrix();
  if (room) {
    room.find(FIND_STRUCTURES).forEach(function (struct) {
      const cost = getStructurePathCost(struct);
      if (cost) costs.set(struct.pos.x, struct.pos.y, cost);
    });
    room.find(FIND_CONSTRUCTION_SITES).forEach(function (struct) {
      // consider construction sites as complete structures
      // same structure types block or don't block movement as complete buildings
      // incomplete roads don't give the speed bonus, but we should still prefer them to avoid planning for additional roads
      const cost = getStructurePathCost(struct);
      if (cost) costs.set(struct.pos.x, struct.pos.y, cost);
    });
    room.find(FIND_SOURCES).forEach(function (source) {
      // avoid routing around sources
      const positions = utils.getPositionsAround(source.pos, 1, 1, true);
      for (const pos of positions) {
        if (costs.get(pos.x, pos.y) < 20) costs.set(pos.x, pos.y, 20);
      }
    });
  }
  return costs;
}

function getCostMatrixSafe(roomName: string) {
  const costMem = Memory.rooms[roomName]?.costMatrix;
  if (costMem) {
    const costs = PathFinder.CostMatrix.deserialize(costMem);
    const exits = Game.map.describeExits(roomName);
    for (const [direction, exitRoomName] of Object.entries(exits)) {
      if (!utils.isRoomSafe(exitRoomName)) {
        if (direction === FIND_EXIT_TOP.toString()) {
          const y = 0;
          for (let x = 0; x <= 49; x++) costs.set(x, y, 0xff);
        } else if (direction === FIND_EXIT_BOTTOM.toString()) {
          const y = 49;
          for (let x = 0; x <= 49; x++) costs.set(x, y, 0xff);
        } else if (direction === FIND_EXIT_LEFT.toString()) {
          const x = 0;
          for (let y = 0; y <= 49; y++) costs.set(x, y, 0xff);
        } else if (direction === FIND_EXIT_RIGHT.toString()) {
          const x = 49;
          for (let y = 0; y <= 49; y++) costs.set(x, y, 0xff);
        }
      }
    }
    return costs;
  }
  return new PathFinder.CostMatrix();
}

function buildRoadsForCarrier(creep: Creep) {
  if (!creep.memory.phases) return;
  for (const phase of creep.memory.phases) {
    if (!phase.move) continue;
    for (const pos of phase.move) {
      pos.createConstructionSite(STRUCTURE_ROAD);
    }
  }
}

function updateStickyEnergy(room: Room) {
  utils.logCpu("updateStickyEnergy(" + room.name + ")");
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
  utils.logCpu("updateStickyEnergy(" + room.name + ")");
}

function checkWipeOut() {
  const count = Object.keys(Game.creeps).length;
  const wipeOut = count < 1;
  if (Memory.wipeOut !== wipeOut) {
    Memory.wipeOut = wipeOut;
    utils.msg("checkWipeOut()", "We have " + count.toString() + " creeps!", true);
  }
}

function countCarriersByCluster(pos: RoomPosition) {
  return Object.values(Game.creeps).filter(
    carrier =>
      carrier.memory.role === "carrier" &&
      carrier.memory.phases &&
      carrier.memory.phases.filter(phase => phase.move && isPosEqual(phase.move[phase.move.length - 1], pos))
        .length > 0
  ).length;
}

function countCarriersBySource(sourceId: Id<StructureContainer | StructureStorage>) {
  return Object.values(Game.creeps).filter(
    carrier =>
      carrier.memory.role === "carrier" &&
      (carrier.memory.storage === sourceId || carrier.memory.container === sourceId)
  ).length;
}

function getCarryCapacityBySource(sourceId: Id<StructureContainer | StructureStorage>) {
  return Object.values(Game.creeps).reduce((totalCapacity, creep) => {
    if (
      creep.memory.role === "carrier" &&
      (creep.memory.storage === sourceId || creep.memory.container === sourceId)
    ) {
      const creepCapacity = creep.store.getCapacity(RESOURCE_ENERGY);
      totalCapacity += creepCapacity || 0;
    }
    return totalCapacity;
  }, 0);
}

function needUpgraders(): boolean {
  for (const roomName in Game.rooms) {
    const room = Game.rooms[roomName];
    if (room.memory.hostilesPresent) continue;
    if (!room.controller) continue;
    if (!room.controller.my) continue;
    const ticksToDowngrade = room.controller.ticksToDowngrade;
    const upgraderCount = countUpgradersAssigned(room.controller.id);
    if (!hasEnoughEnergyForAnotherUpgrader(room.controller) && (ticksToDowngrade > 4000 || upgraderCount > 0))
      continue;
    if (isControllerUpgradedEnough(room.controller)) continue;
    if (upgraderCount >= 5) continue;
    return true;
  }
  return false;
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

function isCarrierPlanValid(creep: Creep) {
  if (!creep.memory.phases) {
    utils.msg(creep, "Invalid plan, phases missing");
    return false;
  }
  let costs;
  let roomName = "";
  for (const phase of creep.memory.phases) {
    if (!phase.move) continue;
    for (const posObj of phase.move) {
      const pos = new RoomPosition(posObj.x, posObj.y, posObj.roomName);
      if (roomName !== posObj.roomName) {
        roomName = posObj.roomName;
        const costMem = Memory.rooms[roomName]?.costMatrix;
        if (!costMem) {
          utils.msg(creep, "Invalid plan, missing costs for room " + roomName);
          return false;
        }
        costs = PathFinder.CostMatrix.deserialize(costMem);
      }
      const cost = costs?.get(pos.x, pos.y);
      if ((cost || 0) > 100) {
        utils.msg(
          creep,
          "Invalid plan, pos " + pos.toString() + " travel cost is " + (cost || "-").toString()
        );
        return false;
      }
    }
  }
  return true;
}
