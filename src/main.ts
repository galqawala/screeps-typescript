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
    maxTickLimit: number;
    paths: Record<string, PathStep[]>;
    plan: Plan;
    reusePath: number;
    username: string;
  }

  interface Plan {
    celebrate: boolean;
    controllersToReserve: Id<StructureController>[];
    fillSpawnsFromStorage: boolean;
    fillStorage: boolean;
    maxEnergyCap: number;
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
    energyStores: EnergyStore[];
    harvestSpots: RoomPosition[];
    hostileRangedAttackParts: number;
    hostilesPresent: boolean;
    lastTimeFlagEnergyConsumerSet: number;
    remoteHarvestScore: number;
    repairTargets: Id<Structure>[];
    score: number;
    sortedSpawnStructureIds: Id<Structure>[];
    status: "normal" | "closed" | "novice" | "respawn";
    updateEnergyStores: boolean;
    upgradeSpots: RoomPosition[];
  }

  interface EnergyStore {
    id: Id<EnergySource | AnyStoreStructure>;
    energy: number;
    freeCap: number;
  }

  interface CreepMemory {
    action?: Action;
    build?: Id<ConstructionSite>;
    deliveryTasks?: DeliveryTask[];
    destination?: DestinationId | RoomPosition;
    pathKey?: string;
    pos: RoomPosition;
    retrieve?: Id<Structure | Tombstone | Ruin | Resource>;
    role: Role;
    sourceId?: Id<Source>;
    transferTo?: Id<Structure>;
    stroke: string;
    strokeWidth: number;
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
  if (Game.cpu.getUsed() > 3) utils.msg("main", "CPU before main: " + Game.cpu.getUsed().toString());
  if ((Memory.maxTickLimit || 0) < Game.cpu.tickLimit) Memory.maxTickLimit = Game.cpu.tickLimit;
  utils.logCpu("mem");
  Memory.reusePath = (Memory.reusePath || 0) + 1;
  if (!Memory.paths) Memory.paths = {};
  for (const key in Memory.creeps) {
    if (!Game.creeps[key]) delete Memory.creeps[key];
  }
  purgeFlags();
  purgeFlagsMemory();
  if (!Memory.username) utils.setUsername();
  utils.logCpu("mem");
  utils.logCpu("handle rooms, flags, creeps, spawns");
  updatePlan();
  for (const r in Game.rooms) handleRoom(Game.rooms[r]);
  updateFlagAttack();
  updateFlagClaim();
  updateFlagReserve();
  updateFlagDismantle();
  handleCreeps();
  utils.logCpu("handle rooms, flags, creeps, spawns");
  const unusedCpuRatio = (Game.cpu.limit - Game.cpu.getUsed()) / Game.cpu.limit;
  Memory.reusePath = Math.max(0, (Memory.reusePath || 0) - Math.ceil(unusedCpuRatio * 2));
  utils.logCpu("main");
  utils.cpuInfo(); // after everything!
});

function updatePlan() {
  let storageMin = Number.POSITIVE_INFINITY;
  const storages = Object.values(Game.structures).filter(utils.isStorage);
  for (const storage of storages) {
    storageMin = Math.min(storageMin, storage.store.getUsedCapacity(RESOURCE_ENERGY));
  }

  Memory.plan = {
    celebrate:
      Object.values(Game.rooms).filter(room => room.controller?.my && room.controller?.progressTotal)
        .length <= 0,
    controllersToReserve: utils.getControllersToReserve().map(controller => controller.id),
    fillSpawnsFromStorage: storageMin >= 900000 && !allSpawnsFull(),
    fillStorage: (storageMin < 150000 && !needHarvesters()) || allSpawnsFull(),
    needAttackers: needAttackers(),
    needCarriers: needCarriers(),
    needExplorers: needExplorers(),
    needHarvesters: storageMin < 900000 && needHarvesters(),
    needInfantry: needInfantry(),
    needReservers: needReservers(),
    needTransferers: needTransferers(),
    needUpgraders:
      storageMin >= 100000 &&
      utils.getCreepCountByRole("upgrader") < 4 * utils.getUpgradeableControllerCount(),
    needWorkers: needWorkers(),
    maxEnergyCap: Math.max(...Object.values(Game.rooms).map(room => room.energyCapacityAvailable)),
    minTicksToDowngrade: Math.min(
      ...Object.values(Game.rooms)
        .filter(room => room.controller && room.controller.my)
        .map(room => room.controller?.ticksToDowngrade || Number.POSITIVE_INFINITY)
    )
  };
}

function needExplorers() {
  return (
    utils.getCreepCountByRole("explorer") < 2 &&
    Object.values(Game.rooms).filter(
      room =>
        room.controller &&
        room.controller.my &&
        CONTROLLER_STRUCTURES[STRUCTURE_OBSERVER][room.controller.level] > 0
    ).length < 1
  );
}

function allSpawnsFull() {
  for (const room of Object.values(Game.rooms)) {
    if (room.energyAvailable < room.energyCapacityAvailable) return false;
  }
  return true;
}

function handleCreeps() {
  utils.logCpu("handleCreeps()");
  for (const c in Game.creeps) {
    if (!Game.creeps[c].spawning) {
      utils.logCpu("creep: " + c);
      const creep = Game.creeps[c];
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

      if (Memory.plan.celebrate && Math.random() < 0.3) celebrate(Game.creeps[c]);
      creep.memory.pos = creep.pos;
      utils.logCpu("creep: " + c);
    }
  }
  utils.logCpu("handleCreeps()");
}

function celebrate(creep: Creep) {
  const emojis = "☺✨❤🌺🌼🍉🍌🍔🍦🍨🍩🍭🎂🎇🎈🎉🎯🎶🏁🏅🏆👌💕💖💙💚💛💜🔈🗣😂😋😍😎😛🙌";
  const symbols = [...emojis];
  creep.say(symbols[Math.floor(Math.random() * symbols.length)], true);
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

function getEnergySource(
  creep: Creep,
  allowStorageAndLink: boolean,
  pos: RoomPosition,
  excludeIds: Id<Structure | Tombstone | Ruin | Resource>[],
  freeCap: number
) {
  utils.logCpu("getEnergySource(" + creep.name + ")");
  const destination = getRoomEnergySource(pos, allowStorageAndLink, excludeIds, pos.roomName, freeCap);
  utils.logCpu("getEnergySource(" + creep.name + ")");
  if (destination) return destination;
  const sources = [];
  for (const roomName of Object.keys(Game.rooms)) {
    if (roomName === pos.roomName) continue; // checked this already in the beginning
    const source = getRoomEnergySource(pos, allowStorageAndLink, excludeIds, roomName, freeCap);
    if (source) sources.push(source);
  }
  const closest = sources
    .map(value => ({
      value,
      sort: utils.getGlobalRange(pos, utils.getPos(value.store))
    })) /* persist sort values */
    .sort((a, b) => a.sort - b.sort) /* sort */
    .map(({ value }) => value) /* remove sort values */[0];
  utils.logCpu("getEnergySource(" + creep.name + ")");
  return closest;
}

function getEnergyDestination(
  creep: Creep,
  allowStorageAndLink: boolean,
  pos: RoomPosition,
  excludeIds: Id<Structure | Tombstone | Ruin | Resource>[]
) {
  utils.logCpu("getEnergyDestination(" + creep.name + ")");
  const destination = getRoomEnergyDestination(pos, allowStorageAndLink, excludeIds, pos.roomName);
  utils.logCpu("getEnergyDestination(" + creep.name + ")");
  if (destination) return destination;
  const destinations = [];
  for (const roomName of Object.keys(Game.rooms)) {
    if (roomName === pos.roomName) continue; // checked this already in the beginning
    const roomDestination = getRoomEnergyDestination(pos, allowStorageAndLink, excludeIds, roomName);
    if (roomDestination) destinations.push(roomDestination);
  }
  const closest = destinations
    .map(value => ({
      value,
      sort: utils.getGlobalRange(pos, utils.getPos(value.store))
    })) /* persist sort values */
    .sort((a, b) => a.sort - b.sort) /* sort */
    .map(({ value }) => value) /* remove sort values */[0];
  utils.logCpu("getEnergyDestination(" + creep.name + ")");
  return closest;
}

function getRoomEnergySource(
  pos: RoomPosition,
  allowStorageAndLink: boolean,
  excludeIds: Id<Structure | Tombstone | Ruin | Resource>[],
  roomName: string,
  freeCap: number
) {
  const sources = [];
  if (!Memory.rooms[roomName].energyStores) Memory.rooms[roomName].energyStores = [];
  const stores = Memory.rooms[roomName].energyStores.filter(
    source =>
      !excludeIds.includes(source.id) &&
      source.energy > 0 &&
      // sources that are full or could make us full
      (source.energy >= freeCap || source.freeCap <= 0)
  );
  if (!stores) return;
  for (const store of stores) {
    const source = Game.getObjectById(store.id);
    if (isValidEnergySource(source, allowStorageAndLink)) sources.push(source);
  }
  const closest = sources
    .map(value => ({
      value,
      sort: utils.getGlobalRange(pos, utils.getPos(value))
    })) /* persist sort values */
    .sort((a, b) => a.sort - b.sort) /* sort */
    .map(({ value }) => value) /* remove sort values */[0];

  if (closest) return { store: closest, info: stores.filter(store => store.id === closest.id)[0] };
  return;
}

function isValidEnergySource(source: EnergySource | AnyStoreStructure | null, allowStorageAndLink: boolean) {
  return (
    source &&
    !(source instanceof StructureExtension) &&
    !(source instanceof StructureSpawn) &&
    !(source instanceof StructureTower) &&
    (allowStorageAndLink || (!utils.isStorage(source) && !utils.isLink(source)))
  );
}

function getRoomEnergyDestination(
  pos: RoomPosition,
  allowStorageAndLink: boolean,
  excludeIds: Id<Structure | Tombstone | Ruin | Resource>[],
  roomName: string
) {
  const destinations = [];
  const stores = Memory.rooms[roomName].energyStores.filter(
    store => !excludeIds.includes(store.id) && store.freeCap > 0
  );
  if (stores) {
    for (const store of stores) {
      const destination = Game.getObjectById(store.id);
      if (
        destination &&
        (!(destination instanceof StructureContainer) || utils.isStorageSubstitute(destination)) &&
        !(destination instanceof Ruin) &&
        (allowStorageAndLink ||
          (!utils.isStorageSubstitute(destination) &&
            !utils.isStorage(destination) &&
            !utils.isLink(destination)))
      )
        destinations.push(destination);
    }
    const closest = destinations
      .map(value => ({
        value,
        sort: utils.getGlobalRange(pos, utils.getPos(value))
      })) /* persist sort values */
      .sort((a, b) => a.sort - b.sort) /* sort */
      .map(({ value }) => value) /* remove sort values */[0];

    if (closest) return { store: closest, info: stores.filter(store => store.id === closest.id)[0] };
  }
  return;
}

function handleUpgrader(creep: Creep) {
  utils.logCpu("handleUpgrader(" + creep.name + ")");

  if (utils.isFull(creep)) delete creep.memory.retrieve;

  if (utils.isEmpty(creep)) {
    workerRetrieveEnergy(creep);
  } else {
    upgrade(creep, false);
  }

  utils.logCpu("handleUpgrader(" + creep.name + ")");
}

function handleWorker(creep: Creep) {
  utils.logCpu("handleWorker(" + creep.name + ")");
  if (utils.isEmpty(creep)) delete creep.memory.build;
  else if (utils.isFull(creep)) delete creep.memory.retrieve;

  if (utils.isEmpty(creep)) {
    workerRetrieveEnergy(creep);
    return;
  }
  utils.logCpu("handleWorker(" + creep.name + ") repairTarget");
  const repairTarget = creep.pos.findInRange(FIND_STRUCTURES, 3).filter(utils.needRepair)[0];
  utils.logCpu("handleWorker(" + creep.name + ") repairTarget");
  if (repairTarget) {
    creep.repair(repairTarget);
  } else if (creep.memory.build) {
    build(creep);
  } else {
    utils.logCpu("handleWorker(" + creep.name + ") work");
    const result = repair(creep) || dismantle(creep) || build(creep);
    utils.logCpu("handleWorker(" + creep.name + ") work");
    utils.logCpu("handleWorker(" + creep.name + ")");
    return result;
  }
  utils.logCpu("handleWorker(" + creep.name + ")");
  return;
}

function workerRetrieveEnergy(creep: Creep) {
  utils.logCpu("workerRetrieveEnergy(" + creep.name + ")");
  let destination;
  const oldDestination = creep.memory.retrieve;
  if (typeof oldDestination === "string") destination = Game.getObjectById(oldDestination);
  if (!destination) {
    destination = getEnergySource(creep, true, creep.pos, [], utils.getFreeCap(creep));
    if (destination && destination.store && "id" in destination.store) {
      creep.memory.retrieve = destination.store.id;
      utils.setDestination(creep, destination.store);
      utils.updateStoreEnergy(
        destination.store.pos.roomName,
        destination.store.id,
        -Math.min(creep.store.getFreeCapacity(RESOURCE_ENERGY), destination.info.energy)
      );
    }
  }

  if (destination instanceof RoomPosition) {
    move(creep, destination);
  } else if (destination instanceof Source && creep.harvest(destination) === ERR_NOT_IN_RANGE) {
    move(creep, destination);
  } else if (
    (destination instanceof Structure ||
      destination instanceof Tombstone ||
      destination instanceof Ruin ||
      destination instanceof Resource) &&
    retrieveEnergy(creep, destination) === ERR_NOT_IN_RANGE
  ) {
    move(creep, destination);
    if (retrieveEnergy(creep, destination) === ERR_NOT_IN_RANGE) utils.setDestination(creep, destination);
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
    creep.memory.build = destination.id;
    if (creep.build(destination) === ERR_NOT_IN_RANGE) {
      utils.logCpu("build(" + creep.name + ") build move");
      move(creep, destination);
      utils.logCpu("build(" + creep.name + ") build move");
      utils.flagEnergyConsumer(destination.pos);
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
  return utils
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
    if (creep.repair(repairTarget) === ERR_NOT_IN_RANGE) move(creep, repairTarget);
    utils.flagEnergyConsumer(repairTarget.pos);
    utils.setDestination(creep, repairTarget);
    utils.logCpu("repair(" + creep.name + ")");
    return true;
  }
  utils.logCpu("repair(" + creep.name + ")");
  return false;
}

function upgrade(creep: Creep, urgentOnly: boolean) {
  utils.logCpu("upgrade(" + creep.name + "," + urgentOnly.toString() + ")");
  const controller = getControllerToUpgrade(creep.pos, urgentOnly);
  utils.flagEnergyConsumer(controller.pos);
  if (controller && creep.upgradeController(controller) === ERR_NOT_IN_RANGE) move(creep, controller);
  utils.logCpu("upgrade(" + creep.name + "," + urgentOnly.toString() + ")");
}

function dismantle(creep: Creep) {
  utils.logCpu("dismantle(" + creep.name + ")");
  const flag = Game.flags.dismantle;
  if (!flag) return false;
  const targets = flag.pos.lookFor(LOOK_STRUCTURES);
  if (targets.length < 1) return false;
  const target = targets[0];
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
    ids = ids.concat(room.memory.repairTargets);
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

function getControllerToUpgrade(pos: RoomPosition, urgentOnly: boolean) {
  utils.logCpu("getControllerToUpgrade(" + pos.toString() + "," + urgentOnly.toString() + ")");
  const targets = [];
  for (const i in Game.rooms) {
    const room = Game.rooms[i];
    if (room.memory.hostilesPresent) continue;
    if (!room.controller) continue;
    if (!room.controller.my) continue;
    if (urgentOnly && room.controller.ticksToDowngrade > 2000) continue;
    targets.push(room.controller);
  }
  const destination = targets
    .map(value => ({
      value,
      sort: utils.getGlobalRange(pos, utils.getPos(value)) + value.ticksToDowngrade / 15
    })) /* persist sort values */
    .sort((a, b) => a.sort - b.sort) /* sort */
    .map(({ value }) => value) /* remove sort values */[0];

  utils.logCpu("getControllerToUpgrade(" + pos.toString() + "," + urgentOnly.toString() + ")");
  return destination;
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
  if (!utils.isEmpty(creep)) {
    const tgt = creep.pos
      .findInRange(FIND_MY_STRUCTURES, 2)
      .filter(utils.hasSpace)
      .filter(
        store =>
          !(store instanceof StructureContainer) &&
          !(store instanceof Ruin) &&
          !utils.isStorage(store) &&
          !utils.isLink(store)
      )[0];
    if (tgt) {
      if (creep.transfer(tgt, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) creep.moveTo(tgt);
      return;
    }
  }
  if (!creep.memory.deliveryTasks) creep.memory.deliveryTasks = [];
  let pos = creep.pos;
  if ("last_" + creep.name in Game.flags) pos = Game.flags["last_" + creep.name].pos;
  if (creep.memory.deliveryTasks.length >= 1) {
    const lastTaskId = creep.memory.deliveryTasks[creep.memory.deliveryTasks.length - 1].destination;
    if (lastTaskId) {
      const lastObj = Game.getObjectById(lastTaskId);
      if (lastObj) pos = lastObj.pos;
    }
  }
  if (creep.memory.deliveryTasks.length < 2) addCarrierDestination(creep, pos);
  if (creep.memory.deliveryTasks.length < 1) return;
  carrierExecutePlan(creep);
  utils.logCpu("handleCarrier(" + creep.name + ")");
}

function carrierExecutePlan(creep: Creep) {
  utils.logCpu("carrierExecutePlan(" + creep.name + ")");
  if (!creep.memory.deliveryTasks) creep.memory.deliveryTasks = [];
  if (creep.memory.deliveryTasks.length < 1) return;
  const task = creep.memory.deliveryTasks[0];
  const destination = Game.getObjectById(task.destination);
  if (!destination || destination.room?.memory.hostilesPresent) {
    utils.resetDestination(creep);
    return;
  }
  move(creep, destination);
  if (!task.isDelivery) {
    // retrieve
    if (utils.isFull(creep) || utils.isEmpty(destination)) {
      utils.resetDestination(creep);
    } else if (isRetrievable(destination)) {
      if (retrieveEnergy(creep, destination) !== ERR_NOT_IN_RANGE) utils.resetDestination(creep);
    }
  } else if (task.isDelivery) {
    // transfer
    if (utils.isEmpty(creep) || utils.isFull(destination)) {
      utils.resetDestination(creep);
    } else if (destination instanceof Creep || destination instanceof Structure) {
      if (transfer(creep, destination) !== ERR_NOT_IN_RANGE) utils.resetDestination(creep);
    }
  } else if (Math.random() < 0.1) {
    // keep moving and try not to block others
    const directions = [TOP, TOP_RIGHT, RIGHT, BOTTOM_RIGHT, BOTTOM, BOTTOM_LEFT, LEFT, TOP_LEFT];
    creep.move(directions[Math.floor(Math.random() * directions.length)]);
  }
  utils.logCpu("carrierExecutePlan(" + creep.name + ")");
}

function isRetrievable(destination: Structure | Tombstone | Ruin | Resource) {
  return (
    destination instanceof Structure ||
    destination instanceof Tombstone ||
    destination instanceof Ruin ||
    destination instanceof Resource
  );
}

function addCarrierDestination(creep: Creep, pos: RoomPosition) {
  utils.logCpu("addCarrierDestination(" + creep.name + ")");
  let upstream;
  let downstream;
  let queuedIds: Id<Structure | Tombstone | Ruin | Resource>[] = [];
  if (creep?.memory?.deliveryTasks) queuedIds = creep?.memory?.deliveryTasks?.map(task => task.destination);
  let energy = creep.store.getUsedCapacity(RESOURCE_ENERGY);
  if (creep.memory.deliveryTasks?.length) {
    for (const task of creep.memory.deliveryTasks) energy += task.energy;
  }
  const cap = creep.store.getCapacity(RESOURCE_ENERGY);
  const storageToSpawn = Memory.plan.fillSpawnsFromStorage;
  if (energy / cap < 0.9) upstream = getEnergySource(creep, storageToSpawn, pos, queuedIds, cap - energy);
  if (energy > 0)
    downstream = getEnergyDestination(creep, Memory.plan.fillStorage && !storageToSpawn, pos, queuedIds);
  if (
    upstream &&
    upstream.store &&
    (!downstream ||
      utils.getGlobalRange(creep.pos, downstream.store.pos) >=
        utils.getGlobalRange(creep.pos, upstream.store.pos))
  ) {
    addCarrierDestinationUpstream(cap, energy, upstream, creep);
    utils.logCpu("addCarrierDestination(" + creep.name + ")");
    return upstream;
  } else if (downstream && utils.isStoreStructure(downstream.store)) {
    addCarrierDestinationDownstream(energy, downstream, creep);
    utils.logCpu("addCarrierDestination(" + creep.name + ")");
    return downstream;
  }
  utils.logCpu("addCarrierDestination(" + creep.name + ")");
  return;
}

function addCarrierDestinationUpstream(
  cap: number,
  energy: number,
  upstream: { store: EnergySource | AnyStoreStructure; info: EnergyStore },
  creep: Creep
) {
  energy = Math.min(cap - energy, upstream.info.energy);
  creep.memory.deliveryTasks?.push({ destination: upstream.store.id, isDelivery: false, energy });
  utils.updateStoreEnergy(upstream.store.pos.roomName, upstream.store.id, -energy);
}

function addCarrierDestinationDownstream(
  energy: number,
  downstream: { store: EnergySource | AnyStoreStructure; info: EnergyStore },
  creep: Creep
) {
  const taskEnergy = Math.min(energy, downstream.info.freeCap);
  utils.updateStoreEnergy(downstream.store.pos.roomName, downstream.store.id, taskEnergy);
  creep.memory.deliveryTasks?.push({
    destination: downstream.store.id,
    isDelivery: true,
    energy: -taskEnergy
  });
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
    const destinations = Memory.plan.controllersToReserve.map(id => Game.getObjectById(id));
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
    if (destination instanceof StructureSpawn || destination instanceof StructureExtension) {
      // First filled spawns/extensions should be used first, as they are probably easier to refill
      if (!creep.room.memory.sortedSpawnStructureIds) creep.room.memory.sortedSpawnStructureIds = [];
      if (!creep.room.memory.sortedSpawnStructureIds.includes(destination.id)) {
        creep.room.memory.sortedSpawnStructureIds.push(destination.id);
      }
    } else if (destination instanceof Creep) {
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
  const bestTarget = utils.getTarget(creep);
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
  const bestTarget = utils.getTarget(creep);
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
  const options = utils.getPositionsAround(creep.pos, 1, 1);
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
  utils.logCpu("harvesterSpendEnergy(" + creep.name + ") repair");
  const target = creep.pos.lookFor(LOOK_STRUCTURES).filter(utils.needRepair)[0];
  if (target) creep.repair(target);
  utils.logCpu("harvesterSpendEnergy(" + creep.name + ") repair");
  utils.logCpu("harvesterSpendEnergy(" + creep.name + ") build");
  const site = creep.pos.lookFor(LOOK_CONSTRUCTION_SITES)[0];
  if (site) creep.build(site);
  utils.logCpu("harvesterSpendEnergy(" + creep.name + ") build");
  utils.logCpu("harvesterSpendEnergy(" + creep.name + ") unloadCreep");
  if (utils.isFull(creep)) unloadCreep(creep);
  utils.logCpu("harvesterSpendEnergy(" + creep.name + ") unloadCreep");
  utils.logCpu("harvesterSpendEnergy(" + creep.name + ")");
}

function unloadCreep(creep: Creep) {
  const pos = creep.pos;
  const destination = pos
    .findInRange(FIND_MY_STRUCTURES, 1)
    .filter(target => !utils.isFull(target) && utils.isLink(target))[0];
  if (destination) {
    creep.transfer(destination, RESOURCE_ENERGY);
    return;
  }
  const targetCreep = pos.findInRange(FIND_CREEPS, 1).filter(wantsEnergy)[0];
  if (targetCreep) {
    creep.transfer(targetCreep, RESOURCE_ENERGY);
    return;
  }
  const myStructure = pos
    .findInRange(FIND_MY_STRUCTURES, 1)
    .filter(target => !utils.isFull(target) && target.my !== false)[0];
  if (myStructure) {
    creep.transfer(myStructure, RESOURCE_ENERGY);
    return;
  }
  const structure = pos
    .findInRange(FIND_STRUCTURES, 1)
    .filter(target => !utils.isFull(target) && !utils.isOwnedStructure(target))[0];
  if (structure) {
    creep.transfer(structure, RESOURCE_ENERGY);
    return;
  }
}

function wantsEnergy(target: Creep) {
  return (
    !utils.isFull(target) &&
    target.my !== false &&
    ["carrier", "upgrader", "worker"].includes(target.memory.role)
  );
}

function handleRoom(room: Room) {
  utils.logCpu("handleRoom(" + room.name + ")");

  utils.logCpu("handleRoom(" + room.name + ") towers");
  const towers = room.find(FIND_MY_STRUCTURES).filter(utils.isTower);
  for (const t of towers) {
    const bestTarget = utils.getTarget(t);
    if (!bestTarget) break; // no targets in this room for any tower
    utils.engageTarget(t, bestTarget);
  }
  utils.logCpu("handleRoom(" + room.name + ") towers");

  utils.logCpu("handleRoom(" + room.name + ") updates1");
  utils.handleHostilesInRoom(room);
  if (utils.canOperateInRoom(room) && Math.random() < 0.03 && Game.cpu.tickLimit > 40)
    utils.constructInRoom(room);
  utils.logCpu("handleRoom(" + room.name + ") updates1");
  utils.logCpu("handleRoom(" + room.name + ") updates2");
  utils.handleLinks(room);
  roomUpdates(room);
  utils.logCpu("handleRoom(" + room.name + ") updates2");
  utils.logCpu("handleRoom(" + room.name + ") updates3");
  handleSpawns(room);
  utils.checkRoomStatus(room);
  utils.checkRoomCanOperate(room);
  utils.tryResetSpawnsAndExtensionsSorting(room);
  utils.logCpu("handleRoom(" + room.name + ") updates3");
  utils.logCpu("handleRoom(" + room.name + ")");
}

function roomUpdates(room: Room) {
  utils.logCpu("roomUpdates(" + room.name + ")");
  if (!room.memory.upgradeSpots) utils.updateUpgradeSpots(room);
  if (!room.memory.harvestSpots) utils.updateHarvestSpots(room);
  if (!room.memory.remoteHarvestScore) utils.updateRemoteHarvestScore(room);
  if (!room.memory.score) utils.updateRoomScore(room);
  if (room.memory.updateEnergyStores || Math.random() < 0.05) utils.updateRoomEnergyStores(room);
  if (Math.random() < 0.02) utils.updateRoomRepairTargets(room);
  utils.logCpu("roomUpdates(" + room.name + ")");
}

function move(creep: Creep, destination: Destination) {
  const tgtPos = utils.getPos(destination);
  if (tgtPos && isPosEqual(creep.pos, tgtPos)) utils.msg(creep, "already at " + destination.toString());
  utils.logCpu("move(" + creep.name + ")");
  if (creep.memory.role !== "explorer") {
    utils.logCpu("move(" + creep.name + ") traffic");
    const flagName = utils.getTrafficFlagName(creep.pos);
    const flag = Game.flags[flagName];
    if (flag) {
      if ("steps" in flag.memory) {
        flag.memory.steps++;
      } else {
        flag.memory.steps = 0;
        flag.memory.initTime = Game.time;
      }
    } else if (utils.shouldMaintainStatsFor(creep.pos)) {
      creep.pos.createFlag(flagName, COLOR_GREEN, COLOR_GREY);
    }
    utils.logCpu("move(" + creep.name + ") traffic");
  }
  let outcome;
  if (utils.getGlobalRange(creep.pos, utils.getPos(destination)) <= 5) {
    delete creep.memory.pathKey;
    outcome = creep.moveTo(destination);
  } else {
    outcome = moveOptimally(creep, destination);
  }
  utils.logCpu("move(" + creep.name + ")");
  return outcome;
}

function moveOptimally(creep: Creep, destination: Destination) {
  utils.logCpu("moveOptimally(" + creep.name + ")");
  const tgtPos = utils.getPos(destination);
  if (!tgtPos) return;
  const key = getPathKey(creep.pos, tgtPos);
  if (!key) {
    creep.moveTo(tgtPos);
    utils.logCpu("moveOptimally(" + creep.name + ")");
    return;
  } else if (!creep.memory.pathKey?.endsWith(":" + getPosKey(tgtPos))) {
    creep.memory.pathKey = key;
  }
  updatePath(key, creep.pos, tgtPos);
  const path = Memory.paths[creep.memory.pathKey];
  const outcome = creep.moveByPath(path);
  if (outcome === ERR_NOT_FOUND) {
    const start = new RoomPosition(path[0].x, path[0].y, creep.pos.roomName);
    const end = new RoomPosition(path[path.length - 1].x, path[path.length - 1].y, creep.pos.roomName);
    if (start && end && utils.getGlobalRange(creep.pos, start) < utils.getGlobalRange(creep.pos, end)) {
      creep.moveTo(start);
    } else {
      const exit = end.findClosestByRange(FIND_EXIT);
      if (exit) creep.moveTo(exit);
    }
  }
  utils.logCpu("moveOptimally(" + creep.name + ")");
}

function updatePath(key: string, from: RoomPosition, to: RoomPosition) {
  utils.logCpu("updatePath(" + key + ")");
  if (!(key in Memory.paths) && Math.random() < 0.1) {
    Memory.paths[key] = from.findPathTo(to, { range: 1 });
  }
  utils.logCpu("updatePath(" + key + ")");
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

function handleSpawns(room: Room) {
  utils.logCpu("handleSpawns(" + room.name + ")");
  const spawn = room.find(FIND_MY_SPAWNS).filter(s => !s.spawning)[0];
  if (spawn) {
    if (Memory.plan.needCarriers) {
      spawnRole("carrier", spawn);
    } else if (Memory.plan.needHarvesters) {
      spawnHarvester(spawn);
    } else if (Memory.plan.needReservers) {
      spawnReserver(spawn);
    } else if (Memory.plan.needInfantry) {
      spawnRole("infantry", spawn);
    } else if (Memory.plan.needAttackers && room.energyAvailable >= Memory.plan.maxEnergyCap) {
      spawnRole("attacker", spawn);
    } else if (Memory.plan.needExplorers) {
      spawnRole("explorer", spawn, 0, [MOVE]);
    } else if (Memory.plan.needTransferers) {
      spawnTransferer(spawn);
    } else if (Memory.plan.needWorkers) {
      spawnRole("worker", spawn);
    } else if (
      Memory.plan.needUpgraders &&
      (room.energyAvailable >= Memory.plan.maxEnergyCap || Memory.plan.minTicksToDowngrade < 4000)
    ) {
      spawnRole("upgrader", spawn, Math.min(450, Memory.plan.maxEnergyCap));
    }
  }
  utils.logCpu("handleSpawns(" + room.name + ")");
}

function needReservers() {
  return (
    Memory.plan.controllersToReserve.length > 0 ||
    ("claim" in Game.flags && utils.getCreepCountByRole("reserver") < 1)
  );
}

function updateFlagClaim() {
  if ("claim" in Game.flags) {
    const room = Game.flags.claim.room;
    if (room && room.controller && room.controller.my) {
      utils.msg(Game.flags.claim, "Clearing 'claim' flag from room " + room.name, true);
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
    const accessibleRooms = Object.values(exits).filter(
      roomName =>
        utils.isRoomSafe(roomName) &&
        Memory.rooms[roomName].canOperate &&
        utils.getRoomStatus(roomName) === utils.getRoomStatus(room.name)
    );
    for (const nearRoomName of accessibleRooms) {
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
  const need =
    utils.getTotalCreepCapacity("carrier") < utils.getTotalEnergyToHaul() ||
    (utils.getTotalCreepCapacity("carrier") < 300 && Memory.plan.fillSpawnsFromStorage);
  utils.logCpu("needCarriers()");
  return need;
}

function needTransferers(): boolean {
  // we have storages without transferrer, next to link that has energy
  return (
    Object.values(Game.structures)
      .filter(utils.isStorage)
      .filter(
        storage =>
          Object.values(Game.creeps).filter(
            creep => creep.memory.role === "transferer" && creep.memory.destination === storage.id
          ).length <= 0 &&
          storage.pos
            .findInRange(FIND_MY_STRUCTURES, 1)
            .filter(utils.isLink)
            .filter(link => utils.getEnergy(link) > 0).length > 0
      ).length > 0
  );
}

function spawnRole(
  roleToSpawn: Role,
  spawn: StructureSpawn,
  minBudget = 0,
  body: undefined | BodyPartConstant[] = undefined
) {
  const budget = Math.floor(
    Math.min(
      Math.max(utils.getCostOfCurrentCreepsInTheRole(roleToSpawn), minBudget),
      Memory.plan.maxEnergyCap
    )
  );

  if (spawn.room.energyAvailable >= budget) {
    spawnCreep(spawn, roleToSpawn, budget, body, undefined);
  }
}

function needInfantry() {
  if (!("attack" in Game.flags)) return false;
  return Memory.rooms[Game.flags.attack.pos.roomName].hostileRangedAttackParts > 0;
}

function needAttackers() {
  return "attack" in Game.flags && utils.getCreepCountByRole("attacker") < 5;
}

function spawnReserver(spawn: StructureSpawn) {
  const minBudget = Math.min(1300, Memory.plan.maxEnergyCap);
  if (minBudget > spawn.room.energyAvailable) return;
  let task: Task | undefined;
  const controller = Game.getObjectById(Memory.plan.controllersToReserve[0]);
  if (controller) {
    task = {
      destination: controller,
      action: "reserveController"
    };
  }
  spawnCreep(spawn, "reserver", minBudget, undefined, task);
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
    if (!utils.shouldHarvestRoom(Game.rooms[r])) continue;
    utils.logCpu("updateFlagAttack() targets");
    targets = targets.concat(getTargetsInRoom(Game.rooms[r]));
    utils.logCpu("updateFlagAttack() targets");
  }
  const target = targets[Math.floor(Math.random() * targets.length)];
  if (target) {
    target.pos.createFlag("attack", COLOR_RED, COLOR_BROWN);
    utils.msg(target, "attack: " + target.pos.toString());
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
  const targets = Memory.plan.controllersToReserve.map(id => Game.getObjectById(id));
  if (targets.length && targets[0]) targets[0].pos.createFlag("reserve", COLOR_ORANGE, COLOR_WHITE);
  utils.logCpu("updateFlagReserve()");
}

function needWorkers() {
  const workParts = Object.values(Game.creeps)
    .filter(creep => creep.memory.role === "worker")
    .reduce((aggregated, item) => aggregated + item.getActiveBodyparts(WORK), 0 /* initial*/);
  const partsNeeded = Math.ceil(getTotalConstructionWork() / 300 + utils.getTotalRepairTargetCount() / 2);
  return partsNeeded > workParts && Memory.plan.minTicksToDowngrade > 4000;
}

function getTotalConstructionWork() {
  return Object.values(Game.constructionSites).reduce(
    (aggregated, item) => aggregated + item.progressTotal - item.progress,
    0 /* initial*/
  );
}

function needHarvesters() {
  const source = getSourceToHarvest(Object.values(Game.spawns)[0].pos);
  if (!source) return false; // nothing to harvest
  return true;
}

function getSourceToHarvest(pos: RoomPosition) {
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
  if (sources.length < 1) return;
  const source = sources
    .map(value => ({ value, sort: utils.getGlobalRange(pos, utils.getPos(value)) })) /* persist sort values */
    .sort((a, b) => a.sort - b.sort) /* sort */
    .map(({ value }) => value) /* remove sort values */[0];
  return source;
}

function spawnHarvester(spawn: StructureSpawn) {
  const roleToSpawn: Role = "harvester";
  const source = getSourceToHarvest(spawn.pos);
  if (!source || !(source instanceof Source)) return;
  let body: BodyPartConstant[] = utils.getBodyForHarvester(source);
  let cost = utils.getBodyCost(body);
  if (cost > spawn.room.energyAvailable) {
    if (utils.getCreepCountByRole("harvester") < 1) {
      body = body.filter((value, index, self) => self.indexOf(value) === index); /* unique */
      cost = utils.getBodyCost(body);
      if (cost > spawn.room.energyAvailable) return false;
    } else {
      return false;
    }
  }
  const energyStructures: (StructureSpawn | StructureExtension)[] = utils.getSpawnsAndExtensionsSorted(
    spawn.room
  );
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
  if (spawn.spawnCreep(body, name, { memory, energyStructures }) === OK) {
    utils.setDestinationFlag(name, harvestPos);
    utils.spawnMsg(spawn, roleToSpawn, name, body, harvestPos.toString());
  }
  return true;
}

function spawnTransferer(spawn: StructureSpawn) {
  const roleToSpawn: Role = "transferer";
  const storages = Object.values(Game.structures)
    .filter(utils.isStorage)
    .filter(
      storage =>
        utils.hasStructureInRange(storage.pos, STRUCTURE_LINK, 1, false) &&
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
  if (cost > spawn.room.energyAvailable) return;
  const name = utils.getNameForCreep(roleToSpawn);
  const energyStructures: (StructureSpawn | StructureExtension)[] = utils.getSpawnsAndExtensionsSorted(
    spawn.room
  );
  if (
    spawn.spawnCreep(body, name, {
      memory: getTransferrerMem(link.id, tgtStorage.id, spawn.pos),
      energyStructures
    }) === OK
  ) {
    utils.spawnMsg(spawn, roleToSpawn, name, body, tgtStorage.toString());
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

function spawnCreep(
  spawn: StructureSpawn,
  roleToSpawn: Role,
  energyAvailable: number,
  body: undefined | BodyPartConstant[],
  task: Task | undefined
) {
  if (!body) body = getBody(roleToSpawn, energyAvailable, Memory.plan.maxEnergyCap);
  const energyStructures = utils.getSpawnsAndExtensionsSorted(spawn.room);
  const name = utils.getNameForCreep(roleToSpawn);

  if (!body || utils.getBodyCost(body) > spawn.room.energyAvailable) return;

  const outcome = spawn.spawnCreep(body, name, {
    memory: getInitialCreepMem(roleToSpawn, task, spawn.pos),
    energyStructures
  });

  if (outcome === OK) {
    spawn.room.memory.updateEnergyStores = true;
    let targetStr;
    if (task && task.destination) {
      targetStr = task.destination.toString();
      if ("pos" in task.destination) targetStr += " @ " + task.destination.pos.roomName;
    }
    utils.spawnMsg(spawn, roleToSpawn, name, body, targetStr);
  } else {
    utils.msg(spawn, "Failed to spawn creep: " + outcome.toString());
  }
}

function getInitialCreepMem(roleToSpawn: Role, task: Task | undefined, pos: RoomPosition) {
  return {
    role: roleToSpawn,
    action: task?.action,
    destination: task?.destination && "id" in task?.destination ? task?.destination?.id : undefined,
    stroke: hslToHex(Math.random() * 360, 100, 50),
    strokeWidth: 0.1 + 0.1 * (Math.random() % 4),
    pos
  };
}

function getBody(roleToSpawn: Role, energyAvailable: number, energyCap: number) {
  if (roleToSpawn === "attacker") return getBodyForAttacker(energyAvailable);
  else if (roleToSpawn === "carrier") return getBodyForCarrier(energyAvailable);
  else if (roleToSpawn === "infantry") return getBodyForInfantry(energyAvailable);
  else if (roleToSpawn === "reserver") return getBodyForReserver(Math.min(3800, energyAvailable));
  else if (roleToSpawn === "upgrader") return getBodyForUpgrader(energyCap);
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
    else if (utils.getBodyPartRatio(body, CARRY) <= 0.2) nextPart = CARRY;

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
    if (name.startsWith("traffic_") && !utils.shouldMaintainStatsFor(flag.pos)) flag.remove();
    if (name.startsWith("creep_") && !(name.substring(6) in Game.creeps)) flag.remove();
  }
  utils.logCpu("purgeFlags()");
}
function isPosEqual(a: RoomPosition, b: RoomPosition) {
  if (a.x !== b.x) return false;
  if (a.y !== b.y) return false;
  if (a.roomName !== b.roomName) return false;
  return true;
}
function getPathKey(from: RoomPosition, to: RoomPosition) {
  const fromKey = getPosKey(from);
  const toKey = getPosKey(to);
  if (fromKey === toKey) {
    return;
  } else {
    return fromKey + ":" + toKey;
  }
}

function getPosKey(pos: RoomPosition) {
  const gridSize = 20;
  const coords = utils.getGlobalCoords(pos);
  return Math.floor(coords.x / gridSize).toString() + "," + Math.floor(coords.y / gridSize).toString();
}
