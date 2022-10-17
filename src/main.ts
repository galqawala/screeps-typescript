// ToDo: Carriers should have a queue of two tasks.
//  If a carrier has an empty task queue, we should add a fetch/delivery near it.
//  If a carrier has a task queue of 1, we should add a fetch/delivery near the last delivery.

// When compiling TS to JS and bundling with rollup, the line numbers and file names in error messages change
// This utility uses source maps to get the line numbers and file names of the original, TS source code
import { ErrorMapper } from "utils/ErrorMapper";
import { Md5 } from "ts-md5";

declare global {
  type Role = "attacker" | "carrier" | "explorer" | "harvester" | "infantry" | "reserver" | "worker";
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
    cpuLimitExceededStreak: number;
    cpuLog: Record<string, CpuLogEntry>;
    needHarvesters: boolean;
    reusePath: number;
    username: string;
  }

  interface FlagMemory {
    steps: number;
    initTime: number;
  }

  interface RoomMemory {
    canOperate: boolean;
    energyDestinations: Id<Structure>[];
    energySources: Id<EnergySource>[];
    harvestSpots: RoomPosition[];
    hostileRangedAttackParts: number;
    hostilesPresent: boolean;
    lastTimeFlagEnergyConsumerSet: number;
    lastTimeSpawnsFull: number;
    linkIsUpstream: Record<Id<StructureLink>, boolean>;
    repairTargets: Id<Structure>[];
    sortedSpawnStructureIds: Id<Structure>[];
    status: "normal" | "closed" | "novice" | "respawn";
    upgradeSpots: RoomPosition[];
  }

  interface CreepMemory {
    action?: Action;
    awaitingDeliveryFrom?: string; // Creep name
    build?: Id<ConstructionSite>;
    destination?: DestinationId | RoomPosition;
    destinationSetTime: number;
    empty: boolean;
    full: boolean;
    getEnergy: boolean;
    lastAction?: Action;
    lastActionOutcome: ScreepsReturnCode;
    lastBlockedIds: DestinationId[];
    lastDestination?: DestinationId | RoomPosition;
    lastMoveTime: number;
    lastOkActionTime: number;
    posRevisits: number;
    retrieve?: Id<Structure | Tombstone | Ruin | Resource>;
    role: Role;
    roomName: string;
    sourceId?: Id<Source>;
    timeOfLastEnergyReceived: number;
    x: number;
    y: number;
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

const minRoadTraffic = 0.015;

function logCpu(name: string) {
  if (!(name in Memory.cpuLog)) {
    // cpuLog is not defined
    Memory.cpuLog[name] = { before: Game.cpu.getUsed(), after: Game.cpu.getUsed() };
  } else {
    Memory.cpuLog[name].after = Game.cpu.getUsed();
  }
}

// Type guards
function isOwnedStructure(structure: Structure): structure is AnyOwnedStructure {
  return (structure as { my?: boolean }).my !== undefined;
}
function isContainerLinkOrStorage(
  structure: Structure
): structure is StructureContainer | StructureLink | StructureStorage {
  return (
    structure.structureType === STRUCTURE_CONTAINER ||
    structure.structureType === STRUCTURE_STORAGE ||
    structure.structureType === STRUCTURE_LINK
  );
}
function isDestructibleWall(structure: Structure): structure is StructureWall {
  return structure.structureType === STRUCTURE_WALL && "hits" in structure;
}
function isLink(structure: Structure): structure is StructureLink {
  return structure.structureType === STRUCTURE_LINK;
}
function isTower(structure: Structure): structure is StructureTower {
  return structure.structureType === STRUCTURE_TOWER;
}
function isSpawnOrExtension(
  structure: Structure | null | undefined | Destination
): structure is StructureSpawn | StructureExtension {
  if (!structure) return false;
  if (!("structureType" in structure)) return false;
  return structure.structureType === STRUCTURE_SPAWN || structure.structureType === STRUCTURE_EXTENSION;
}
function isRoomPosition(item: RoomPosition): item is RoomPosition {
  return item instanceof RoomPosition;
}

// Main loop
export const loop = ErrorMapper.wrapLoop(() => {
  Memory.reusePath = (Memory.reusePath || 0) + 1;
  Memory.cpuLog = {};
  logCpu("purge/update memory");
  for (const key in Memory.creeps) {
    if (!Game.creeps[key]) delete Memory.creeps[key];
  }
  purgeFlags();
  purgeFlagsMemory();
  if (!Memory.username) setUsername();
  logCpu("purge/update memory");

  logCpu("handle rooms, flags, creeps, spawns");
  for (const r in Game.rooms) handleRoom(Game.rooms[r]);
  updateFlagAttack();
  updateFlagReserve();
  updateFlagDismantle();
  handleCreeps();
  logCpu("updateFlagReserve() handleSpawn");
  for (const s in Game.spawns) handleSpawn(Game.spawns[s]);
  logCpu("updateFlagReserve() handleSpawn");
  logCpu("handle rooms, flags, creeps, spawns");
  cpuInfo();
  const unusedCpuRatio = (Game.cpu.limit - Game.cpu.getUsed()) / Game.cpu.limit;
  Memory.reusePath = Math.max(0, (Memory.reusePath || 0) - Math.ceil(unusedCpuRatio * 2));
});

function handleCreeps() {
  logCpu("handleCreeps()");
  for (const c in Game.creeps) {
    logCpu("creep: " + c);
    const role = Game.creeps[c].memory.role;

    if (role === "attacker") handleAttacker(Game.creeps[c]);
    else if (role === "carrier") handleCarrier(Game.creeps[c]);
    else if (role === "explorer") handleExplorer(Game.creeps[c]);
    else if (role === "harvester") handleHarvester(Game.creeps[c]);
    else if (role === "infantry") handleInfantry(Game.creeps[c]);
    else if (role === "reserver") handleReserver(Game.creeps[c]);
    else if (role === "worker") handleWorker(Game.creeps[c]);

    logCpu("creep: " + c);
  }
  logCpu("handleCreeps()");
}

function handleExplorer(creep: Creep) {
  logCpu("handleExplorer(" + creep.name + ")");
  creep.notifyWhenAttacked(false);
  if (!moveTowardMemory(creep)) {
    const destination = getExit(creep.pos, !creep.ticksToLive || creep.ticksToLive > 300, false);
    if (destination) {
      move(creep, destination);
      setDestination(creep, destination);
    }
  }
  logCpu("handleExplorer(" + creep.name + ")");
}

function getEnergySource(creep: Creep, allowStorage: boolean, allowAnyLink: boolean) {
  logCpu("getEnergySource(" + creep.name + ")");
  const destination = getRoomEnergySource(creep.pos, allowStorage, allowAnyLink);
  logCpu("getEnergySource(" + creep.name + ")");
  if (destination) return destination;
  const shuffledRoomNames = Object.keys(Game.rooms)
    .map(value => ({ value, sort: Math.random() })) /* persist sort values */
    .sort((a, b) => a.sort - b.sort) /* sort */
    .map(({ value }) => value); /* remove sort values */
  for (const roomName of shuffledRoomNames) {
    if (roomName === creep.pos.roomName) continue; // checked this already in the beginning
    const source = getRoomEnergySource(getRandomPos(roomName), allowStorage, allowAnyLink);
    logCpu("getEnergySource(" + creep.name + ")");
    if (source) return source;
  }
  logCpu("getEnergySource(" + creep.name + ")");
  return;
}

function getRoomEnergySource(pos: RoomPosition, allowStorage: boolean, allowAnyLink: boolean) {
  const sources = [];
  const ids = Memory.rooms[pos.roomName].energySources;
  if (ids) {
    for (const id of ids) {
      const source = Game.getObjectById(id);
      if (
        source &&
        (allowStorage || (!(source instanceof StructureStorage) && (allowAnyLink || !isUpstreamLink(source))))
      )
        sources.push(source);
    }
    const closest = pos.findClosestByRange(sources);
    return closest;
  }
  return;
}

function clearEnergySource(
  source:
    | Tombstone
    | Ruin
    | StructureLink
    | StructureStorage
    | StructureContainer
    | Resource<ResourceConstant>
) {
  if (source && !(source instanceof StructureStorage)) {
    const index = Memory.rooms[source.pos.roomName].energySources.indexOf(source.id);
    if (index > -1) Memory.rooms[source.pos.roomName].energySources.splice(index, 1);
  }
}

function isUpstreamLink(structure: Destination) {
  if (!(structure instanceof StructureLink)) return false;
  if (structure.room.memory.linkIsUpstream && structure.room.memory.linkIsUpstream[structure.id] === true)
    return true;
  return false;
}
function isDownstreamLink(structure: Destination) {
  if (!(structure instanceof StructureLink)) return false;
  if (structure.room.memory.linkIsUpstream && structure.room.memory.linkIsUpstream[structure.id] === false)
    return true;
  return false;
}

function getEnergyDestination(creep: Creep) {
  logCpu("getEnergyDestination(" + creep.name + ")");
  const destination = getRoomEnergyDestination(creep.pos);
  logCpu("getEnergyDestination(" + creep.name + ")");
  if (destination) return destination;
  const shuffledRoomNames = Object.keys(Game.rooms)
    .map(value => ({ value, sort: Math.random() })) /* persist sort values */
    .sort((a, b) => a.sort - b.sort) /* sort */
    .map(({ value }) => value); /* remove sort values */
  for (const roomName of shuffledRoomNames) {
    if (roomName === creep.pos.roomName) continue; // checked this already in the beginning
    const roomDestination = getRoomEnergyDestination(getRandomPos(roomName));
    logCpu("getEnergyDestination(" + creep.name + ")");
    if (roomDestination) return roomDestination;
  }
  logCpu("getEnergyDestination(" + creep.name + ")");
  return;
}

function getRoomEnergyDestination(pos: RoomPosition) {
  const destinations = [];
  const ids = Memory.rooms[pos.roomName].energyDestinations;
  if (ids) {
    for (const id of ids) {
      const destination = Game.getObjectById(id);
      if (
        destination &&
        !isDownstreamLink(destination) &&
        !(destination instanceof StructureContainer) &&
        (!(destination instanceof StructureLink) || pos.getRangeTo(destination) <= 6)
      )
        destinations.push(destination);
    }
    const closest = pos.findClosestByRange(destinations);
    if (closest && !(closest instanceof StructureStorage)) {
      const index = Memory.rooms[pos.roomName].energyDestinations.indexOf(closest.id);
      if (index > -1) Memory.rooms[pos.roomName].energyDestinations.splice(index, 1);
    }
    return closest;
  }
  return;
}

function handleWorker(creep: Creep) {
  logCpu("handleWorker(" + creep.name + ")");
  if (isEmpty(creep)) delete creep.memory.build;
  else if (isFull(creep)) delete creep.memory.retrieve;

  if (creep.memory.build) {
    build(creep);
  } else if (creep.memory.awaitingDeliveryFrom && isEdge(creep.pos)) {
    move(creep, getRandomPos(creep.pos.roomName)); // move once towards a random position
  } else if (isEmpty(creep)) {
    workerRetrieveEnergy(creep);
  } else if (!isEmpty(creep)) {
    logCpu("handleWorker(" + creep.name + ") work");
    const result =
      upgrade(creep, true) || repair(creep) || dismantle(creep) || build(creep) || upgrade(creep, false);
    logCpu("handleWorker(" + creep.name + ") work");
    logCpu("handleWorker(" + creep.name + ")");
    return result;
  }
  logCpu("handleWorker(" + creep.name + ")");
  return;
}

function workerRetrieveEnergy(creep: Creep) {
  logCpu("workerRetrieveEnergy(" + creep.name + ")");
  let destination;
  const oldDestination = creep.memory.retrieve;
  if (typeof oldDestination === "string") destination = Game.getObjectById(oldDestination);
  if (!destination) {
    destination = getEnergySource(creep, true, true);
    if (destination) {
      creep.memory.retrieve = destination.id;
      setDestination(creep, destination);
      clearEnergySource(destination);
    }
  }

  if (destination instanceof RoomPosition) {
    move(creep, destination);
  } else if (destination instanceof Source && creep.harvest(destination) === ERR_NOT_IN_RANGE) {
    if (move(creep, destination) === OK) creep.harvest(destination);
  } else if (
    (destination instanceof Structure ||
      destination instanceof Tombstone ||
      destination instanceof Ruin ||
      destination instanceof Resource) &&
    retrieveEnergy(creep, destination) === ERR_NOT_IN_RANGE
  ) {
    move(creep, destination);
    if (retrieveEnergy(creep, destination) === ERR_NOT_IN_RANGE) setDestination(creep, destination);
  }
  logCpu("workerRetrieveEnergy(" + creep.name + ")");
}

function build(creep: Creep) {
  logCpu("build(" + creep.name + ")");
  logCpu("build(" + creep.name + ") find");
  let destination;
  const oldDestination = creep.memory.build;
  if (typeof oldDestination === "string") {
    destination = Game.getObjectById(oldDestination);
    if (!destination) delete creep.memory.build;
  }
  if (!destination || !(destination instanceof ConstructionSite)) {
    const destinations = getConstructionSites(creep);
    if (!destination) destination = creep.pos.findClosestByRange(destinations); // same room
    if (!destination) destination = destinations[Math.floor(Math.random() * destinations.length)]; // another room
  }
  logCpu("build(" + creep.name + ") find");
  logCpu("build(" + creep.name + ") build");
  if (destination instanceof ConstructionSite) {
    creep.memory.build = destination.id;
    setDestination(creep, destination);
    if (creep.build(destination) === ERR_NOT_IN_RANGE) {
      move(creep, destination);
      flagEnergyConsumer(destination.pos);
      logCpu("build(" + creep.name + ") build");
      logCpu("build(" + creep.name + ")");
      return true;
    }
  }
  logCpu("build(" + creep.name + ") build");
  logCpu("build(" + creep.name + ")");
  return false;
}

function repair(creep: Creep) {
  logCpu("repair(" + creep.name + ")");
  const oldDestination = creep.memory.destination;
  let destination;
  let repairTarget;
  if (typeof oldDestination === "string") destination = Game.getObjectById(oldDestination);
  if (destination instanceof Structure && needRepair(destination)) repairTarget = destination;
  if (!repairTarget) repairTarget = getRepairTarget(creep.pos);
  if (repairTarget) {
    if (creep.repair(repairTarget) === ERR_NOT_IN_RANGE)
      if (move(creep, repairTarget) === OK) creep.repair(repairTarget);
    flagEnergyConsumer(repairTarget.pos);
    setDestination(creep, repairTarget);
    logCpu("repair(" + creep.name + ")");
    return true;
  }
  logCpu("repair(" + creep.name + ")");
  return false;
}

function upgrade(creep: Creep, urgentOnly: boolean) {
  logCpu("upgrade(" + creep.name + "," + urgentOnly.toString() + ")");
  const controller = getControllerToUpgrade(creep.pos, urgentOnly);
  if (controller && creep.upgradeController(controller) === ERR_NOT_IN_RANGE) {
    if (move(creep, controller) === OK) creep.upgradeController(controller);
    flagEnergyConsumer(controller.pos);
    logCpu("upgrade(" + creep.name + "," + urgentOnly.toString() + ")");
    return true;
  }
  logCpu("upgrade(" + creep.name + "," + urgentOnly.toString() + ")");
  return false;
}

function dismantle(creep: Creep) {
  logCpu("dismantle(" + creep.name + ")");
  const flag = Game.flags.dismantle;
  if (!flag) return false;
  const targets = flag.pos.lookFor(LOOK_STRUCTURES);
  if (targets.length < 1) return false;
  const target = targets[0];
  if (creep.dismantle(target) === ERR_NOT_IN_RANGE) {
    if (move(creep, target) === OK) creep.dismantle(target);
    logCpu("dismantle(" + creep.name + ")");
    return true;
  }
  logCpu("dismantle(" + creep.name + ")");
  return false;
}

function getRepairTarget(pos: RoomPosition) {
  const sources = [];
  const ids = Memory.rooms[pos.roomName].repairTargets;
  if (ids) {
    for (const id of ids) {
      const source = Game.getObjectById(id);
      if (source) sources.push(source);
    }
    const closest = pos.findClosestByRange(sources);
    if (closest) {
      const index = Memory.rooms[pos.roomName].repairTargets.indexOf(closest.id);
      if (index > -1) Memory.rooms[pos.roomName].repairTargets.splice(index, 1);
    }
    return closest;
  }
  return;
}

function getControllerToUpgrade(pos: RoomPosition, urgentOnly: boolean) {
  logCpu("getControllerToUpgrade(" + pos.toString() + "," + urgentOnly.toString() + ")");
  const targets = [];
  for (const i in Game.rooms) {
    const room = Game.rooms[i];
    if (room.memory.hostilesPresent) continue;
    if (!room.controller) continue;
    if (!room.controller.my) continue;
    if (urgentOnly && room.controller.ticksToDowngrade > 2000) continue;
    targets.push(room.controller);
  }
  let destination = pos.findClosestByRange(targets); // same room
  if (!destination) destination = targets[Math.floor(Math.random() * targets.length)]; // another room
  logCpu("getControllerToUpgrade(" + pos.toString() + "," + urgentOnly.toString() + ")");
  return destination;
}

function cpuInfo() {
  if (Game.cpu.getUsed() > Game.cpu.limit) {
    Memory.cpuLimitExceededStreak++;
    if (Memory.cpuLimitExceededStreak >= 2)
      msg(
        "cpuInfo()",
        Game.cpu.getUsed().toString() +
          "/" +
          Game.cpu.limit.toString() +
          " CPU used! Limit exceeded " +
          Memory.cpuLimitExceededStreak.toString() +
          " ticks in a row.\n" +
          getCpuLog()
      );
  } else {
    Memory.cpuLimitExceededStreak = 0;
  }
}

function getCpuLog() {
  const sortable = [];
  for (const name in Memory.cpuLog) {
    const entry: CpuLogEntryFinal = { name, cpu: Memory.cpuLog[name].after - Memory.cpuLog[name].before };
    sortable.push(entry);
  }
  return sortable
    .sort(function (a, b) {
      return b.cpu - a.cpu;
    })
    .map(entry => entry.name + ": " + entry.cpu.toString())
    .join("\n");
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
    move(creep, destination);
    if (creep.pos.getRangeTo(destination) <= 1) resetDestination(creep);
    return true;
  }
  return false;
}

function handleCarrier(creep: Creep) {
  logCpu("handleCarrier(" + creep.name + ")");
  let destination;
  logCpu("handleCarrier(" + creep.name + ") oldDestination");
  if ("getEnergy" in creep.memory) {
    const oldDestination = creep.memory.destination;
    if (typeof oldDestination === "string") destination = Game.getObjectById(oldDestination);
  }
  logCpu("handleCarrier(" + creep.name + ") oldDestination");
  logCpu("handleCarrier(" + creep.name + ") plan new destination");
  if (!destination) {
    destination = getCarrierDestination(creep);
    if (destination) setDestination(creep, destination);
  }
  logCpu("handleCarrier(" + creep.name + ") plan new destination");
  logCpu("handleCarrier(" + creep.name + ") carrierExecutePlan");
  if (destination) carrierExecutePlan(creep, destination);
  logCpu("handleCarrier(" + creep.name + ") carrierExecutePlan");
  logCpu("handleCarrier(" + creep.name + ")");
}

function carrierExecutePlan(creep: Creep, destination: Destination) {
  logCpu("carrierExecutePlan(" + creep.name + "," + destination.toString() + ")");
  logCpu("carrierExecutePlan(" + creep.name + "," + destination.toString() + ") move");
  move(creep, destination);
  logCpu("carrierExecutePlan(" + creep.name + "," + destination.toString() + ") move");
  if (
    creep.memory.getEnergy &&
    (destination instanceof Structure ||
      destination instanceof Tombstone ||
      destination instanceof Ruin ||
      destination instanceof Resource)
  ) {
    if (retrieveEnergy(creep, destination) !== ERR_NOT_IN_RANGE) resetDestination(creep);
  } else if (!creep.memory.getEnergy && (destination instanceof Creep || destination instanceof Structure)) {
    const outcome = transfer(creep, destination);
    if (outcome !== ERR_NOT_IN_RANGE) {
      resetDestination(creep);
    }
  }
  logCpu("carrierExecutePlan(" + creep.name + "," + destination.toString() + ")");
}

function getCarrierDestination(creep: Creep) {
  logCpu("getCarrierDestination(" + creep.name + ")");
  let upstream;
  let downstream;
  if (getFillRatio(creep) < 0.9) upstream = getEnergySource(creep, false, false);
  if (!isEmpty(creep)) downstream = getEnergyDestination(creep);
  if (upstream && (!downstream || creep.pos.getRangeTo(downstream) >= creep.pos.getRangeTo(upstream))) {
    creep.memory.getEnergy = true;
    clearEnergySource(upstream);
    logCpu("getCarrierDestination(" + creep.name + ")");
    return upstream;
  } else if (downstream) {
    creep.memory.getEnergy = false;
    logCpu("getCarrierDestination(" + creep.name + ")");
    return downstream;
  }
  logCpu("getCarrierDestination(" + creep.name + ")");
  return;
}

function handleReserver(creep: Creep) {
  if (creep.memory.action === "recycleCreep" || creep.room.memory.hostilesPresent) {
    recycleCreep(creep);
    return;
  }
  let destination;
  const oldDestination = creep.memory.destination;
  if (typeof oldDestination === "string") destination = Game.getObjectById(oldDestination);

  if (destination && destination instanceof StructureController) {
    if (creep.reserveController(destination) === ERR_NOT_IN_RANGE) move(creep, destination);
  } else {
    const destinations = getControllersToReserve();
    if (destinations.length && destinations[0]) {
      setDestination(creep, destinations[0]);
      move(creep, destinations[0]);
    } else {
      const flag = Game.flags.reserve;
      if (flag) move(creep, flag);
    }
  }
}

function transfer(creep: Creep, destination: Creep | Structure<StructureConstant>) {
  const actionOutcome = creep.transfer(destination, RESOURCE_ENERGY);
  if (actionOutcome === OK && destination) {
    if ("memory" in destination) {
      destination.memory.timeOfLastEnergyReceived = Game.time;
      resetDestination(creep);
    }
    if (destination instanceof StructureSpawn || destination instanceof StructureExtension) {
      // First filled spawns/extensions should be used first, as they are probably easier to refill
      if (!creep.room.memory.sortedSpawnStructureIds) creep.room.memory.sortedSpawnStructureIds = [];
      if (!creep.room.memory.sortedSpawnStructureIds.includes(destination.id)) {
        creep.room.memory.sortedSpawnStructureIds.push(destination.id);
      }
    } else if (destination instanceof Creep) {
      // the receiver should reconsider what to do after getting the energy
      resetDestination(destination);
    }
  }
  if (actionOutcome === OK) resetSpecificDestinationFromCreeps(destination);
  return actionOutcome;
}

function retrieveEnergy(creep: Creep, destination: Structure | Tombstone | Ruin | Resource) {
  if (getEnergy(destination) <= 0) delete creep.memory.retrieve;
  if (destination instanceof Structure || destination instanceof Tombstone || destination instanceof Ruin) {
    return withdraw(creep, destination);
  } else if (destination instanceof Resource) {
    return pickup(creep, destination);
  }
  return ERR_INVALID_TARGET;
}

function purgeFlagsMemory() {
  logCpu("purgeFlagsMemory()");
  for (const key in Memory.flags) {
    if (!Game.flags[key]) delete Memory.flags[key];
  }
  logCpu("purgeFlagsMemory()");
}

function purgeFlags() {
  logCpu("purgeFlags()");
  for (const flag of Object.values(Game.flags)) {
    const name = flag.name;
    if (name.startsWith("traffic_") && !shouldMaintainStatsFor(flag.pos)) flag.remove();
    if (name.startsWith("creep_") && !(name.substring(6) in Game.creeps)) flag.remove();
  }
  logCpu("purgeFlags()");
}

function shouldMaintainStatsFor(pos: RoomPosition) {
  // to save CPU, gather stats for only part of the rooms and switch focus after certain interval
  const sections = 2;
  const interval = 10000;
  return pos.x % sections === Math.floor(Game.time / interval) % sections;
}

function getTrafficFlagName(pos: RoomPosition) {
  return "traffic_" + pos.roomName + "_" + pos.x.toString() + "_" + pos.y.toString();
}

function handleAttacker(creep: Creep) {
  logCpu("handleAttacker(" + creep.name + ")");
  const flag = Game.flags.attack;
  const bestTarget = getTarget(creep);
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
  logCpu("handleAttacker(" + creep.name + ")");
}

function handleInfantry(creep: Creep) {
  logCpu("handleInfantry(" + creep.name + ")");
  const flag = Game.flags.attack;
  const bestTarget = getTarget(creep);
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
  logCpu("handleInfantry(" + creep.name + ")");
}

function evadeHostiles(creep: Creep) {
  logCpu("evadeHostiles(" + creep.name + ")");
  const hostilePositions = creep.pos
    .findInRange(FIND_HOSTILE_CREEPS, 4)
    .map(hostile => hostile.pos)
    .concat(creep.pos.findInRange(FIND_HOSTILE_POWER_CREEPS, 4).map(hostile => hostile.pos));
  if (hostilePositions.length < 1) return;
  const options = getPositionsAround(creep.pos);
  let bestRange = Number.NEGATIVE_INFINITY;
  let bestPos;
  for (const pos of options) {
    const closest = pos.findClosestByRange(hostilePositions);
    const range = closest ? pos.getRangeTo(closest) : Number.NEGATIVE_INFINITY;
    if (bestRange < range) {
      bestRange = range;
      bestPos = pos;
    }
  }
  if (bestPos) move(creep, bestPos);
  logCpu("evadeHostiles(" + creep.name + ")");
}

function getPositionsAround(origin: RoomPosition) {
  logCpu("getPositionsAround(" + origin.toString() + ")");
  const range = 1; // distance we move in one tick
  const terrain = new Room.Terrain(origin.roomName);
  const spots: RoomPosition[] = [];

  for (let x = origin.x - range; x <= origin.x + range; x++) {
    for (let y = origin.y - range; y <= origin.y + range; y++) {
      if (x < 0 || x > 49 || y < 0 || y > 49) continue;
      if (x === origin.x && y === origin.y) continue;
      if (terrain.get(x, y) === TERRAIN_MASK_WALL) continue;
      const pos = new RoomPosition(x, y, origin.roomName);
      if (blockedByStructure(pos)) continue;
      spots.push(pos);
    }
  }
  logCpu("getPositionsAround(" + origin.toString() + ")");
  return spots
    .map(value => ({ value, sort: Math.random() })) /* persist sort values */
    .sort((a, b) => b.sort - a.sort) /* sort */
    .map(({ value }) => value); /* remove sort values */
}

function setUsername() {
  logCpu("setUsername()");
  // room controllers
  for (const r in Game.rooms) {
    const room = Game.rooms[r];
    if (room.controller && room.controller.my && room.controller.owner) {
      Memory.username = room.controller.owner.username;
      logCpu("setUsername()");
      return;
    }
  }
  // creeps
  const creeps = Object.values(Game.creeps);
  if (creeps.length) {
    Memory.username = creeps[0].owner.username;
    logCpu("setUsername()");
    return;
  }
  logCpu("setUsername()");
}

function getControllersToReserve() {
  logCpu("getControllersToReserve()");
  const controllers = [];
  for (const r in Game.rooms) {
    const controller = Game.rooms[r].controller;
    if (
      controller &&
      shouldReserveRoom(Game.rooms[r]) &&
      shouldHarvestRoom(Game.rooms[r]) &&
      !creepsHaveDestination(controller)
    ) {
      controllers.push(controller);
    }
  }
  logCpu("getControllersToReserve()");
  return controllers
    .map(value => ({ value, sort: value?.reservation?.ticksToEnd || 0 }))
    .sort((a, b) => a.sort - b.sort)
    .map(({ value }) => value);
}

function creepsHaveDestination(structure: Structure) {
  logCpu("creepsHaveDestination(" + structure.toString() + ")");
  if (!structure) return false;
  if (!structure.id) return false;
  if (
    Object.values(Game.creeps).filter(function (creep) {
      return creep.memory.destination === structure.id;
    }).length
  ) {
    logCpu("creepsHaveDestination(" + structure.toString() + ")");
    return true;
  }
  logCpu("creepsHaveDestination(" + structure.toString() + ")");
  return false;
}

function shouldReserveRoom(room: Room) {
  const controller = room.controller;
  if (room.memory.hostilesPresent) return false;
  if (!controller) return false;
  if (controller.owner) return false;
  if (isReservationOk(controller)) return false;
  if (isReservedByOthers(controller)) return false;
  return true;
}

function isReservationOk(controller: StructureController) {
  const reservation = controller.reservation;
  if (!reservation) return false;
  if (reservation.username !== Memory.username) return false;
  if (reservation.ticksToEnd < 2500) return false;
  return true;
}

function isReservedByOthers(controller: StructureController) {
  const reservation = controller.reservation;
  if (!reservation) return false;
  if (reservation.username !== Memory.username) return true;
  return false;
}

function recycleCreep(creep: Creep) {
  creep.say("💀");
  creep.memory.action = "recycleCreep";
  let destination;
  const oldDestination = creep.memory.destination;
  if (typeof oldDestination === "string") destination = Game.getObjectById(oldDestination);
  if (!(destination instanceof StructureSpawn)) destination = resetDestination(creep);

  if (!destination || !(destination instanceof StructureSpawn)) {
    const spawns = Object.values(Game.spawns);
    destination = creep.pos.findClosestByRange(spawns); // same room
    if (!destination) destination = spawns[Math.floor(Math.random() * spawns.length)]; // another room
    if (destination) {
      setDestination(creep, destination);
    }
  }

  if (destination) {
    if (creep.pos.getRangeTo(destination) <= 1 && destination instanceof StructureSpawn) {
      if (destination.recycleCreep(creep) === OK) msg(creep, "recycled!");
    } else {
      move(creep, destination);
    }
  }
}

function handleHarvester(creep: Creep) {
  logCpu("handleHarvester(" + creep.name + ")");
  if (creep.memory.role !== "harvester") return false;
  if (creep.spawning) return true;
  if (
    creep.memory.action === "recycleCreep" ||
    creep.room.memory.hostilesPresent ||
    !("creep_" + creep.name in Game.flags)
  ) {
    recycleCreep(creep);
    return true;
  }
  // move
  const flagName = "creep_" + creep.name;
  const flag = Game.flags[flagName];
  move(creep, flag);
  if (!isEmpty(creep)) harvesterSpendEnergy(creep);
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
  logCpu("handleHarvester(" + creep.name + ")");
  return true;
}

function harvesterSpendEnergy(creep: Creep) {
  logCpu("harvesterSpendEnergy(" + creep.name + ")");
  const target = creep.pos.findClosestByRange(creep.pos.findInRange(FIND_STRUCTURES, 3).filter(needRepair));
  if (target) creep.repair(target);
  // build
  const site = creep.pos.findClosestByRange(creep.pos.findInRange(FIND_MY_CONSTRUCTION_SITES, 3));
  if (site) creep.build(site);
  // upgrade controller
  if (creep.room.controller) creep.upgradeController(creep.room.controller);
  // transfer
  logCpu("harvesterSpendEnergy(" + creep.name + ") unloadCreep");
  if (isFull(creep)) unloadCreep(creep);
  logCpu("harvesterSpendEnergy(" + creep.name + ") unloadCreep");
  logCpu("harvesterSpendEnergy(" + creep.name + ")");
}

function unloadCreep(creep: Creep) {
  const pos = creep.pos;
  const destination = pos.findClosestByRange(
    // link
    pos.findInRange(FIND_MY_STRUCTURES, 1).filter(target => !isFull(target) && isLink(target))
  );
  if (destination) {
    creep.transfer(destination, RESOURCE_ENERGY);
    return;
  }
  const targetCreep = pos.findClosestByRange(
    // carrier
    pos.findInRange(FIND_CREEPS, 1).filter(wantsEnergy)
  );
  if (targetCreep) {
    creep.transfer(targetCreep, RESOURCE_ENERGY);
    return;
  }
  const myStructure = pos.findClosestByRange(
    // my structure
    pos.findInRange(FIND_MY_STRUCTURES, 1).filter(target => !isFull(target) && target.my !== false)
  );
  if (myStructure) {
    creep.transfer(myStructure, RESOURCE_ENERGY);
    return;
  }
  const structure = pos.findClosestByRange(
    // unowned structure
    pos.findInRange(FIND_STRUCTURES, 1).filter(target => !isFull(target) && !isOwnedStructure(target))
  );
  if (structure) {
    creep.transfer(structure, RESOURCE_ENERGY);
    return;
  }
}

function wantsEnergy(target: Creep) {
  return (
    !isFull(target) && target.my !== false && ["carrier", "spawner", "worker"].includes(target.memory.role)
  );
}

function handleRoom(room: Room) {
  logCpu("handleRoom(" + room.name + ")");
  // control the towers
  logCpu("handleRoom(" + room.name + ") towers");
  const towers = room.find(FIND_MY_STRUCTURES).filter(isTower);
  for (const t of towers) {
    const bestTarget = getTarget(t);
    if (!bestTarget) break; // no targets in this room for any tower
    engageTarget(t, bestTarget);
  }
  logCpu("handleRoom(" + room.name + ") towers");

  handleHostilesInRoom(room);

  if (canOperateInRoom(room) && Math.random() < 0.04) constructInRoom(room);

  // handle the links
  handleLinks(room);

  logCpu("handleRoom(" + room.name + ") updates");
  if (!room.memory.upgradeSpots) updateUpgradeSpots(room);
  if (!room.memory.harvestSpots) updateHarvestSpots(room);
  if (Math.random() < 0.1) updateRoomEnergySources(room);
  if (Math.random() < 0.1) updateRoomEnergyDestinations(room);
  if (Math.random() < 0.1) updateRoomRepairTargets(room);
  logCpu("handleRoom(" + room.name + ") updates");

  // check the room details
  logCpu("handleRoom(" + room.name + ") details");
  checkRoomStatus(room);
  checkRoomCanOperate(room);
  checkRoomEnergy(room);
  logCpu("handleRoom(" + room.name + ") details");
  logCpu("handleRoom(" + room.name + ")");
}

function updateRoomRepairTargets(room: Room) {
  logCpu("updateRoomRepairTargets(" + room.name + ")");
  const targets: Structure[] = room
    .find(FIND_STRUCTURES)
    .filter(target => needRepair(target) && (getHpRatio(target) || 1) < 0.9 && !isUnderRepair(target));
  room.memory.repairTargets = targets.map(target => target.id);
  logCpu("updateRoomRepairTargets(" + room.name + ")");
}

function getHpRatio(obj: Structure) {
  if ("hits" in obj && "hitsMax" in obj) return obj.hits / obj.hitsMax;
  return;
}

function updateRoomEnergySources(room: Room) {
  logCpu("updateRoomEnergySources(" + room.name + ")");
  if (room.memory.hostilesPresent) {
    room.memory.energySources = [];
    return;
  }
  let sources: EnergySource[] = room.find(FIND_DROPPED_RESOURCES);
  sources = sources.concat(room.find(FIND_TOMBSTONES).filter(tomb => getEnergy(tomb) > 0));
  sources = sources.concat(room.find(FIND_RUINS).filter(ruin => getEnergy(ruin) > 0));
  sources = sources.concat(
    room
      .find(FIND_STRUCTURES)
      .filter(isContainerLinkOrStorage)
      .filter(structure => getEnergy(structure) > 0)
  );
  room.memory.energySources = sources.map(source => source.id);
  logCpu("updateRoomEnergySources(" + room.name + ")");
}

function updateRoomEnergyDestinations(room: Room) {
  logCpu("updateRoomEnergyDestinations(" + room.name + ")");
  room.memory.energyDestinations = room
    .find(FIND_STRUCTURES)
    .filter(hasSpace)
    .filter(structure => !(structure instanceof StructureStorage) || shouldFillStorage(room))
    .map(structure => structure.id);
  logCpu("updateRoomEnergyDestinations(" + room.name + ")");
}

function shouldFillStorage(room: Room) {
  // should we fill storage (instead of spawns/extensions)
  if (areSpawnsFull()) return true;
  if (getCreepsMaxTicksToLive() < 850) return false; // haven't spawned creeps lately
  if (getCreepCountByRole("explorer") < 1) return false;
  if (room.memory.lastTimeSpawnsFull || 0 < Game.time - 1500) return false;
  return true;
}

function getCreepsMaxTicksToLive() {
  return Object.values(Game.creeps).reduce(
    (aggregated, item) => Math.max(aggregated, item.ticksToLive || 0),
    0 /* initial*/
  );
}

function areSpawnsFull() {
  for (const room of Object.values(Game.rooms)) {
    if (room.energyAvailable < room.energyCapacityAvailable) return false;
  }
  return true;
}

function constructInRoom(room: Room) {
  logCpu("constructInRoom(" + room.name + ")");
  // construct some structures
  const structureTypes = [
    STRUCTURE_EXTENSION,
    STRUCTURE_LINK,
    STRUCTURE_ROAD,
    STRUCTURE_SPAWN,
    STRUCTURE_STORAGE,
    STRUCTURE_TOWER
  ];
  structureTypes.forEach(structureType => construct(room, structureType));
  logCpu("constructInRoom(" + room.name + ")");
}

function checkRoomStatus(room: Room) {
  const value = getRoomStatus(room.name);
  if (room.memory.status !== value) {
    msg(room, "Status: " + room.memory.status + " ➤ " + value.toString(), true);
    room.memory.status = value;
  }
}

function checkRoomCanOperate(room: Room) {
  const value = canOperateInRoom(room);
  if (room.memory && room.memory.canOperate !== value) {
    msg(
      room,
      "Can operate: " + (room.memory.canOperate || "-").toString() + " ➤ " + (value || "-").toString()
    );
    room.memory.canOperate = value;
  }
}

function checkRoomEnergy(room: Room) {
  if (room.energyAvailable < 50) {
    tryResetSpawnsAndExtensionsSorting(room);
  } else if (room.energyAvailable >= room.energyCapacityAvailable) {
    room.memory.lastTimeSpawnsFull = Game.time;
  }
}

function handleHostilesInRoom(room: Room) {
  logCpu("handleHostilesInRoom(" + room.name + ")");
  // check for presence of hostiles
  const hostileCreeps = room.find(FIND_HOSTILE_CREEPS);
  const hostilePowerCreeps = room.find(FIND_HOSTILE_POWER_CREEPS);
  const totalHostiles = hostileCreeps.length + hostilePowerCreeps.length;
  const hostilesPresent = totalHostiles > 0;

  if (room.memory.hostilesPresent !== hostilesPresent) {
    if (hostilesPresent) {
      const hostileOwners = getHostileUsernames(hostileCreeps, hostilePowerCreeps);
      msg(room, totalHostiles.toString() + " hostiles from " + hostileOwners.join() + " detected!", false);
    } else {
      msg(room, "clear of hostiles =)", false);
    }
    room.memory.hostilesPresent = hostilesPresent;
    room.memory.hostileRangedAttackParts = room
      .find(FIND_HOSTILE_CREEPS)
      .reduce((aggregated, item) => aggregated + item.getActiveBodyparts(RANGED_ATTACK), 0 /* initial*/);
  }

  // enable safe mode if necessary
  if (hostilesPresent) {
    const towerCount = room
      .find(FIND_MY_STRUCTURES)
      .filter(tower => tower.structureType === STRUCTURE_TOWER).length;
    if (towerCount <= 0) {
      if (room.controller && room.controller.activateSafeMode() === OK) {
        msg(room.controller, "safe mode activated!", true);
      }
    }
  }
  logCpu("handleHostilesInRoom(" + room.name + ")");
}

function getHostileUsernames(hostileCreeps: Creep[], hostilePowerCreeps: PowerCreep[]) {
  return hostileCreeps
    .map(creep => creep.owner.username)
    .concat(hostilePowerCreeps.map(creep => creep.owner.username))
    .filter((value, index, self) => self.indexOf(value) === index); // unique
}

function updateUpgradeSpots(room: Room) {
  if (!room.controller) return;
  msg(room, "Updating upgrade spots");
  const targetPos = room.controller.pos;
  const range = 3;
  const terrain = new Room.Terrain(room.name);
  const spots: RoomPosition[] = [];

  for (let x = targetPos.x - range; x <= targetPos.x + range; x++) {
    for (let y = targetPos.y - range; y <= targetPos.y + range; y++) {
      if (x === targetPos.x && y === targetPos.y) continue;
      if (terrain.get(x, y) === TERRAIN_MASK_WALL) continue;
      const pos = new RoomPosition(x, y, room.name);
      if (spots.includes(pos)) msg(room, pos.toString() + " already listed");
      spots.push(pos);
    }
  }
  room.memory.upgradeSpots = spots;
}

function updateHarvestSpots(room: Room) {
  msg(room, "Updating harvest spots");
  const range = 1;
  const terrain = new Room.Terrain(room.name);
  const spots: RoomPosition[] = [];

  room.find(FIND_SOURCES).forEach(source => {
    const targetPos = source.pos;

    for (let x = targetPos.x - range; x <= targetPos.x + range; x++) {
      for (let y = targetPos.y - range; y <= targetPos.y + range; y++) {
        if (x === targetPos.x && y === targetPos.y) continue;
        if (terrain.get(x, y) === TERRAIN_MASK_WALL) continue;
        const pos = new RoomPosition(x, y, room.name);
        if (blockedByStructure(pos)) continue;
        if (!containsPosition(spots, pos)) spots.push(pos);
      }
    }
    room.memory.harvestSpots = spots;
  });
}

function blockedByStructure(pos: RoomPosition) {
  return (
    pos
      .lookFor(LOOK_STRUCTURES)
      .filter(structure => (OBSTACLE_OBJECT_TYPES as StructureConstant[]).includes(structure.structureType))
      .length > 0
  );
}

function containsPosition(list: RoomPosition[], pos: RoomPosition) {
  return (
    list.filter(listPos => listPos.x === pos.x && listPos.y === pos.y && listPos.roomName === pos.roomName)
      .length > 0
  );
}

function getLinkDownstreamPos(room: Room) {
  logCpu("getLinkDownstreamPos(" + room.name + ")");
  const flagName = room.name + "_EnergyConsumer";
  if (!(flagName in Game.flags)) return;
  const flag = Game.flags[flagName];
  const destination = flag.pos;
  if (getCreepCountByRole("worker", false, 0) < 1) {
    // move energy toward storage when we have no workers
    const storages = room
      .find(FIND_STRUCTURES)
      .filter(structure => structure.structureType === STRUCTURE_STORAGE);
    logCpu("getLinkDownstreamPos(" + room.name + ")");
    if (storages.length) return storages[0].pos;
  }
  logCpu("getLinkDownstreamPos(" + room.name + ")");
  return destination;
}

function handleLinks(room: Room) {
  logCpu("handleLinks(" + room.name + ")");
  // move energy towards the energy consumer
  const downstreamPos = getLinkDownstreamPos(room);
  logCpu("handleLinks(" + room.name + ")");
  if (!downstreamPos) return;

  logCpu("handleLinks(" + room.name + ") sort");
  const links = getSortedLinks(room, downstreamPos);
  logCpu("handleLinks(" + room.name + ") sort");
  logCpu("handleLinks(" + room.name + ") loop");
  let upstreamIndex = 0;
  let downstreamIndex = links.length - 1;
  while (upstreamIndex < downstreamIndex) {
    const upstreamLink = links[upstreamIndex];
    const downstreamLink = links[downstreamIndex];

    if (isEmpty(upstreamLink) || upstreamLink.cooldown) {
      upstreamIndex++;
    } else if (getFillRatio(downstreamLink) >= 0.9) {
      downstreamIndex--;
    } else {
      upstreamLink.transferEnergy(downstreamLink);
      upstreamIndex++;
      resetSpecificDestinationFromCreeps(upstreamLink);
      resetSpecificDestinationFromCreeps(downstreamLink);
      updateLinkMemory(upstreamLink, downstreamLink);
    }
  }
  logCpu("handleLinks(" + room.name + ") loop");
  logCpu("handleLinks(" + room.name + ")");
}

function getSortedLinks(room: Room, downstreamPos: RoomPosition) {
  logCpu("getSortedLinks(" + room.name + ")");
  const links = room
    .find(FIND_MY_STRUCTURES)
    .filter(isLink)
    .map(value => ({ value, sort: value.pos.getRangeTo(downstreamPos) })) /* persist sort values */
    .sort((a, b) => b.sort - a.sort) /* sort */
    .map(({ value }) => value); /* remove sort values */
  logCpu("getSortedLinks(" + room.name + ")");
  return links;
}

function updateLinkMemory(upstreamLink: StructureLink, downstreamLink: StructureLink) {
  if (!upstreamLink.room.memory.linkIsUpstream) upstreamLink.room.memory.linkIsUpstream = {};
  upstreamLink.room.memory.linkIsUpstream[upstreamLink.id] = true;
  downstreamLink.room.memory.linkIsUpstream[downstreamLink.id] = false;
}

function canAttack(myUnit: StructureTower | Creep) {
  if (myUnit instanceof StructureTower) return true;
  if (myUnit.getActiveBodyparts(ATTACK) > 0) return true;
  if (myUnit.getActiveBodyparts(RANGED_ATTACK) > 0) return true;
  return false;
}
function canHeal(myUnit: StructureTower | Creep) {
  if (myUnit instanceof StructureTower) return true;
  if (myUnit.getActiveBodyparts(HEAL) > 0) return true;
  return false;
}

function getTargetCreep(myUnit: StructureTower | Creep) {
  let bestTarget;
  let bestTargetScore = Number.NEGATIVE_INFINITY;
  const creeps = myUnit.room
    .find(FIND_CREEPS)
    .filter(
      target =>
        (canAttack(myUnit) && target.my === false) ||
        (canHeal(myUnit) && target.my !== false && target.hits < target.hitsMax)
    );
  for (const targetCreep of creeps) {
    const score = getTargetScore(myUnit.pos, targetCreep);
    if (bestTargetScore < score) {
      bestTargetScore = score;
      bestTarget = targetCreep;
    }
  }
  if (bestTarget) {
    const scoredTarget: ScoredTarget = { score: bestTargetScore, target: bestTarget };
    return scoredTarget;
  }
  return;
}

function getTargetPowerCreep(myUnit: StructureTower | Creep) {
  let bestTarget;
  let bestTargetScore = Number.NEGATIVE_INFINITY;
  const powerCreeps = myUnit.room
    .find(FIND_POWER_CREEPS)
    .filter(
      target =>
        (canAttack(myUnit) && target.my === false) ||
        (canHeal(myUnit) && target.my !== false && target.hits < target.hitsMax)
    );
  for (const targetPowerCreep of powerCreeps) {
    const score = getTargetScore(myUnit.pos, targetPowerCreep);
    if (bestTargetScore < score) {
      bestTargetScore = score;
      bestTarget = targetPowerCreep;
    }
  }
  if (bestTarget) {
    const scoredTarget: ScoredTarget = { score: bestTargetScore, target: bestTarget };
    return scoredTarget;
  }
  return;
}

function getTargetStructure(myUnit: StructureTower | Creep) {
  if (!canAttack(myUnit)) return;
  let bestTarget;
  let bestTargetScore = Number.NEGATIVE_INFINITY;
  const structures = myUnit.room.find(FIND_HOSTILE_STRUCTURES);
  for (const targetStructure of structures) {
    const score = getTargetScore(myUnit.pos, targetStructure);
    if (bestTargetScore < score) {
      bestTargetScore = score;
      bestTarget = targetStructure;
    }
  }
  if (bestTarget) {
    const scoredTarget: ScoredTarget = { score: bestTargetScore, target: bestTarget };
    return scoredTarget;
  }
  return;
}

function isEnemy(object: Structure | Creep | PowerCreep) {
  if (object instanceof Creep || object instanceof PowerCreep) return object.my === false;
  return isOwnedStructure(object) && object.my === false;
}

function engageTarget(myUnit: StructureTower | Creep, target: Structure | Creep | PowerCreep) {
  if (isEnemy(target) || target instanceof StructureWall) {
    return myUnit.attack(target);
  } else if (target instanceof Creep || target instanceof PowerCreep) {
    return myUnit.heal(target);
  } else {
    return myUnit.repair(target);
  }
}

function getTarget(myUnit: StructureTower | Creep) {
  logCpu("getTarget(" + myUnit.toString() + ")");
  logCpu("getTarget(" + myUnit.toString() + ") getTargetCreep");
  const creep = getTargetCreep(myUnit);
  logCpu("getTarget(" + myUnit.toString() + ") getTargetCreep");
  logCpu("getTarget(" + myUnit.toString() + ") getTargetPowerCreep");
  const powerCreep = getTargetPowerCreep(myUnit);
  logCpu("getTarget(" + myUnit.toString() + ") getTargetPowerCreep");
  logCpu("getTarget(" + myUnit.toString() + ") getTargetStructure");
  const structure = getTargetStructure(myUnit);
  logCpu("getTarget(" + myUnit.toString() + ") getTargetStructure");

  logCpu("getTarget(" + myUnit.toString() + ") target");
  const targets = [];
  if (creep) targets.push(creep);
  if (powerCreep) targets.push(powerCreep);
  if (structure) targets.push(structure);
  logCpu("getTarget(" + myUnit.toString() + ") target");

  logCpu("getTarget(" + myUnit.toString() + ")");
  if (targets.length < 1) return;
  logCpu("getTarget(" + myUnit.toString() + ") sort");
  const best = targets.sort((a, b) => b.score - a.score)[0].target;
  logCpu("getTarget(" + myUnit.toString() + ") sort");
  logCpu("getTarget(" + myUnit.toString() + ")");
  return best;
}

function getTargetScore(pos: RoomPosition, target: Structure | Creep | PowerCreep) {
  let score = -pos.getRangeTo(target);
  if ("my" in target) {
    if (target.my === false) score += 10;
    if (target.my === true) score -= 10;
  }
  if (target instanceof Creep) score += target.getActiveBodyparts(HEAL);
  return score;
}

function isEdge(pos: RoomPosition) {
  if (pos.x <= 0) return true;
  if (pos.y <= 0) return true;
  if (pos.x >= 49) return true;
  if (pos.y >= 49) return true;
  return false;
}

function setDestination(creep: Creep, destination: Destination) {
  logCpu("setDestination(" + creep.name + ")");
  logCpu("setDestination(" + creep.name + ") update memory");
  if (destination && creep.memory.destination !== ("id" in destination ? destination.id : destination)) {
    if ("id" in destination) {
      creep.memory.destination = destination.id;
      creep.memory.destinationSetTime = Game.time;
    } else if (destination instanceof RoomPosition) {
      creep.memory.destination = destination;
      creep.memory.destinationSetTime = Game.time;
    }
  }
  logCpu("setDestination(" + creep.name + ") update memory");
  logCpu("setDestination(" + creep.name + ") set flag");
  if ("pos" in destination) setDestinationFlag(creep.name, destination.pos);
  else if (destination instanceof RoomPosition) setDestinationFlag(creep.name, destination);
  logCpu("setDestination(" + creep.name + ") set flag");
  logCpu("setDestination(" + creep.name + ")");
}

function move(creep: Creep, destination: Destination) {
  logCpu("move(" + creep.name + ")");
  const flagName = getTrafficFlagName(creep.pos);
  const flag = Game.flags[flagName];
  if (flag) {
    if ("steps" in flag.memory) {
      flag.memory.steps++;
    } else {
      flag.memory.steps = 0;
      flag.memory.initTime = Game.time;
    }
  } else if (shouldMaintainStatsFor(creep.pos)) {
    creep.pos.createFlag(flagName, COLOR_GREEN, COLOR_GREY);
  }
  logCpu("move(" + creep.name + ") moveTo");
  const outcome = creep.moveTo(destination, {
    reusePath: Memory.reusePath,
    visualizePathStyle: { stroke: getHashColor(creep.memory.role), opacity: 0.9 }
  });
  logCpu("move(" + creep.name + ") moveTo");
  logCpu("move(" + creep.name + ")");
  return outcome;
}

function withdraw(creep: Creep, destination: Destination) {
  if (destination instanceof Structure || destination instanceof Tombstone || destination instanceof Ruin) {
    const actionOutcome = creep.withdraw(destination, RESOURCE_ENERGY);
    if (actionOutcome === OK) resetSpecificDestinationFromCreeps(destination);
    return actionOutcome;
  }
  return ERR_INVALID_TARGET;
}

function pickup(creep: Creep, destination: Destination) {
  if (destination instanceof Resource) {
    const actionOutcome = creep.pickup(destination);
    if (actionOutcome === OK) resetSpecificDestinationFromCreeps(destination);
    return actionOutcome;
  }
  return ERR_INVALID_TARGET;
}

function resetSpecificDestinationFromCreeps(destination: Destination) {
  for (const i in Game.creeps) {
    const creep = Game.creeps[i];
    if (creep.memory.destination && "id" in destination && creep.memory.destination === destination.id) {
      resetDestination(creep);
    }
  }
}

function needRepair(structure: Structure) {
  if (!structure) return false;
  if (isOwnedStructure(structure) && structure.my === false) return false;
  if (!structure.hits) return false;
  if (!structure.hitsMax) return false;
  if (structure.hits >= structure.hitsMax) return false;
  if (structure instanceof StructureRoad && getTrafficRateAt(structure.pos) < minRoadTraffic) return false;
  return true;
}

function getRandomPos(roomName: string) {
  const x = Math.floor(Math.random() * 50);
  const y = Math.floor(Math.random() * 50);
  return new RoomPosition(x, y, roomName);
}

function flagEnergyConsumer(pos: RoomPosition) {
  if (Memory.rooms[pos.roomName].lastTimeFlagEnergyConsumerSet >= Game.time) return;
  logCpu("flagEnergyConsumer(" + pos.toString() + ")");
  const flagName = pos.roomName + "_EnergyConsumer";
  if (flagName in Game.flags) {
    const flag = Game.flags[flagName];
    flag.setPosition(pos); /* handles the first setColor or setPosition per tick! */
  } else {
    pos.createFlag(flagName, COLOR_BLUE, COLOR_PURPLE);
  }
  Memory.rooms[pos.roomName].lastTimeFlagEnergyConsumerSet = Game.time;
  logCpu("flagEnergyConsumer(" + pos.toString() + ")");
}

function getConstructionSites(creep: Creep) {
  let sites: ConstructionSite[] = [];
  for (const i in Game.rooms) {
    const room = Game.rooms[i];
    if (room.memory.hostilesPresent) continue;
    sites = sites.concat(
      room
        .find(FIND_MY_CONSTRUCTION_SITES)
        .filter(
          target =>
            target.structureType !== STRUCTURE_CONTAINER /* leave for harvesters */ &&
            !isBlocked(creep, target)
        )
    );
  }
  return sites;
}

function isUnderRepair(structure: Structure) {
  if (!structure) return false;
  if (!structure.id) return false;
  const creepsRepairingIt = Object.values(Game.creeps).filter(function (creep) {
    return creep.memory.action === "repair" && creep.memory.destination === structure.id;
  }).length;
  if (creepsRepairingIt) return true;
  return false;
}

function getHashColor(seed: string) {
  const hash = Md5.hashStr(seed);
  let offset = 0;
  let hex;
  let hsl;
  do {
    hex = hash.substring(0 + offset, 6 + offset);
    hsl = hexToHSL(hex);
    offset++;
  } while (!hsl || hsl.l < 0.6);
  // msg('getHashColor',seed+' > '+hex+' > H:'+hsl['h']+', S:'+hsl['s']+', l:'+hsl['l']+' offset:'+offset);
  return "#" + hex;
}

function isBlocked(creep: Creep, target: ConstructionSite | Structure) {
  if (!creep.memory.lastBlockedIds) return false;
  if (creep.memory.lastBlockedIds.includes(target.id)) return true;
  return false;
}

function tryResetSpawnsAndExtensionsSorting(room: Room) {
  // First filled spawns/extensions should be used first, as they are probably easier to refill
  // If none are full we can forget the old order and learn a new one
  if (
    room
      .find(FIND_MY_STRUCTURES)
      .filter(
        structure =>
          (structure.structureType === STRUCTURE_EXTENSION || structure.structureType === STRUCTURE_SPAWN) &&
          isFull(structure)
      ).length <= 0
  ) {
    room.memory.sortedSpawnStructureIds = [];
  }
}

function canOperateInRoom(room: Room) {
  if (!room.controller) return true; // no controller
  if (room.controller.my) return true; // my controller
  const reservation = room.controller.reservation;
  if (reservation && reservation.username === Memory.username) return true; // reserved to me
  if (!room.controller.owner && !reservation) return true; // no owner & no reservation
  return false;
}

function getRoomStatus(roomName: string) {
  return Game.map.getRoomStatus(roomName).status;
}

function isRoomSafe(roomName: string) {
  if (!Memory.rooms[roomName]) return true;
  if (Memory.rooms[roomName].hostilesPresent) return false;
  return true;
}

function getExit(pos: RoomPosition, safeOnly = true, harvestableOnly = true) {
  if (!pos) return;
  const exits = Game.map.describeExits(pos.roomName);
  const accessibleRooms = Object.values(exits).filter(
    roomName =>
      (!safeOnly || isRoomSafe(roomName)) &&
      (!harvestableOnly || Memory.rooms[roomName].canOperate) &&
      getRoomStatus(roomName) === getRoomStatus(pos.roomName)
  );
  const getDestinationRoomName = accessibleRooms[Math.floor(Math.random() * accessibleRooms.length)];
  const findExit = Game.map.findExit(pos.roomName, getDestinationRoomName);
  if (findExit === ERR_NO_PATH) {
    msg(pos, "getExit(): no path between rooms: " + pos.roomName + " - " + getDestinationRoomName);
  } else if (findExit === ERR_INVALID_ARGS) {
    msg(pos, "getExit() passed invalid arguments to Game.map.findExit()");
  } else {
    const exit = pos.findClosestByRange(findExit);
    if (exit && isRoomPosition(exit)) return exit;
  }
  return;
}

function getPosForStorage(room: Room) {
  // next to the link, controller and upgrade spots
  if (!room) return;
  const controller = room.controller;
  if (!controller) return;
  const targetPos = getPosOfLinkByTheController(controller);
  if (!targetPos) return;

  let bestScore = Number.NEGATIVE_INFINITY;
  let bestPos;
  const terrain = new Room.Terrain(room.name);

  for (let x = targetPos.x - 1; x <= targetPos.x + 1; x++) {
    for (let y = targetPos.y - 1; y <= targetPos.y + 1; y++) {
      if (x === targetPos.x && y === targetPos.y) continue;
      if (terrain.get(x, y) === TERRAIN_MASK_WALL) continue;
      const pos = new RoomPosition(x, y, room.name);
      let score = getNearbyWorkSpotCount(pos, true);
      if (hasStructureInRange(pos, undefined, 1, true)) score -= 0.1;
      if (bestScore < score) {
        bestScore = score;
        bestPos = pos;
      }
    }
  }

  return bestPos;
}

function getPosOfLinkByTheController(controller: StructureController) {
  let targetPos;
  const linkFilter = {
    filter: { structureType: STRUCTURE_LINK }
  };
  const link = controller.pos.findClosestByRange(FIND_MY_STRUCTURES, linkFilter);
  if (link) {
    targetPos = link.pos;
  } else {
    const site = controller.pos.findClosestByRange(FIND_MY_CONSTRUCTION_SITES, linkFilter);
    if (site) targetPos = site.pos;
  }
  if (!targetPos) return;
  if (targetPos.getRangeTo(controller.pos) > 6) return;
  return targetPos;
}

function getPrimaryPosForLink(room: Room) {
  // around controller and sources
  const range = 3;
  const terrain = new Room.Terrain(room.name);

  const placesRequiringLink: (StructureController | Source)[] = getPlacesRequiringLink(room);

  for (const target of placesRequiringLink) {
    if (target && !hasStructureInRange(target.pos, STRUCTURE_LINK, 6, true)) {
      const targetPos = target.pos;
      let bestScore = -1;
      let bestPos;

      for (let x = targetPos.x - range; x <= targetPos.x + range; x++) {
        for (let y = targetPos.y - range; y <= targetPos.y + range; y++) {
          if (x === targetPos.x && y === targetPos.y) continue;
          if (terrain.get(x, y) === TERRAIN_MASK_WALL) continue;
          const pos = new RoomPosition(x, y, room.name);
          let score = getNearbyWorkSpotCount(pos, target instanceof StructureController);
          if (hasStructureInRange(pos, undefined, 1, true)) score -= 0.1;
          if (bestScore < score) {
            bestScore = score;
            bestPos = pos;
          }
        }
      }

      if (bestPos) return bestPos;
    }
  }
  return;
}

function getPlacesRequiringLink(room: Room) {
  let placesRequiringLink: (StructureController | Source)[] = [];
  if (room.controller) placesRequiringLink.push(room.controller);
  placesRequiringLink = placesRequiringLink.concat(
    room
      .find(FIND_SOURCES)
      .map(value => ({ value, sort: Math.random() })) /* persist sort values */
      .sort((a, b) => a.sort - b.sort) /* sort */
      .map(({ value }) => value) /* remove sort values */
  );
  return placesRequiringLink;
}

function getNearbyWorkSpotCount(pos: RoomPosition, upgradeSpots: boolean) {
  const spots = upgradeSpots
    ? Memory.rooms[pos.roomName].upgradeSpots
    : Memory.rooms[pos.roomName].harvestSpots;
  let spotsAround = 0;
  spots.forEach(spot => {
    if (pos.getRangeTo(spot.x, spot.y) === 1) spotsAround++;
  });
  return spotsAround;
}

function hasStructureInRange(
  pos: RoomPosition,
  structureType: StructureConstant | undefined,
  range: number,
  includeConstructionSites: boolean
) {
  if (
    pos
      .findInRange(FIND_MY_STRUCTURES, range)
      .filter(structure => !structureType || structure.structureType === structureType).length > 0
  )
    return true;

  if (
    includeConstructionSites &&
    pos
      .findInRange(FIND_MY_CONSTRUCTION_SITES, range)
      .filter(structure => !structureType || structure.structureType === structureType).length > 0
  )
    return true;

  return false;
}

function adjustConstructionSiteScoreForLink(score: number, pos: RoomPosition) {
  // distance to exit decreases the score
  const penalty = pos.findClosestByRange(FIND_EXIT);
  if (penalty) {
    score /= pos.getRangeTo(penalty);
    score /= pos.getRangeTo(penalty);
  }
  // distance to other links increases the score
  let shortestRange;
  const link = pos.findClosestByRange(FIND_MY_STRUCTURES, { filter: { structureType: STRUCTURE_LINK } });
  if (link) shortestRange = pos.getRangeTo(link);
  const linkSite = pos.findClosestByRange(FIND_MY_CONSTRUCTION_SITES, {
    filter: { structureType: STRUCTURE_LINK }
  });
  if (linkSite) {
    const range = pos.getRangeTo(linkSite);
    if (!shortestRange || shortestRange > range) shortestRange = range;
  }
  if (shortestRange) {
    score *= shortestRange;
  }
  return score;
}

function getPosForConstruction(room: Room, structureType: StructureConstant) {
  if (structureType === STRUCTURE_LINK) {
    const linkPos = getPrimaryPosForLink(room);
    if (linkPos) return linkPos;
  }
  if (structureType === STRUCTURE_STORAGE) return getPosForStorage(room);
  if (structureType === STRUCTURE_ROAD) return getPosForRoad(room);

  let bestScore = Number.NEGATIVE_INFINITY;
  let bestPos;
  const sites = getPotentialConstructionSites(room);

  for (const { pos, score } of sites) {
    let finalScore = score;
    if (structureType === STRUCTURE_LINK) {
      finalScore = adjustConstructionSiteScoreForLink(score, pos);
    } else if (structureType === STRUCTURE_EXTENSION || structureType === STRUCTURE_SPAWN) {
      // distance to source decreases the score
      const extensionPenalty = pos.findClosestByRange(FIND_SOURCES);
      if (extensionPenalty) {
        finalScore /= pos.getRangeTo(extensionPenalty);
      }
    }

    if (bestScore < finalScore) {
      bestScore = finalScore;
      bestPos = pos;
    }
  }

  return bestPos;
}

function getPosForRoad(room: Room) {
  const flags = room
    .find(FIND_FLAGS)
    .filter(
      flag =>
        flag.name.startsWith("traffic_") &&
        flag.memory &&
        flag.memory.steps > 0 &&
        flag.memory.initTime < Game.time - 1000
    );
  let bestScore = Number.NEGATIVE_INFINITY;
  let bestPos;
  for (const flag of flags) {
    if (isEdge(flag.pos)) continue;
    const score = getTrafficRate(flag);
    if (
      bestScore < score &&
      score > minRoadTraffic &&
      flag.pos.lookFor(LOOK_STRUCTURES).length <= 0 &&
      flag.pos.lookFor(LOOK_CONSTRUCTION_SITES).length <= 0
    ) {
      bestScore = score;
      bestPos = flag.pos;
    }
  }
  return bestPos;
}

function getTrafficRate(flag: Flag) {
  if (!flag) return 0;
  if (!("initTime" in flag.memory)) return 0;
  if (flag.memory.initTime >= Game.time) return 0;
  return (flag.memory.steps || 0) / (Game.time - flag.memory.initTime);
}

function getTrafficRateAt(pos: RoomPosition) {
  return getTrafficRate(Game.flags[getTrafficFlagName(pos)]);
}

function getPotentialConstructionSites(room: Room) {
  const sites: ScoredPos[] = [];

  for (let x = 2; x <= 47; x++) {
    for (let y = 2; y <= 47; y++) {
      if ((x + y) % 2 === 1) continue; // build in a checkered pattern to allow passage
      const pos = room.getPositionAt(x, y);
      if (!pos) continue;
      if (!isPosSuitableForConstruction(pos)) continue;
      const score =
        (hasStructureInRange(pos, STRUCTURE_ROAD, 1, true) ? 1 : 0) - pos.lookFor(LOOK_STRUCTURES).length;
      sites.push({ score, pos });
    }
  }

  return sites;
}

function isPosSuitableForConstruction(pos: RoomPosition) {
  const contents = pos.look();
  for (const content of contents) {
    if (content.type !== "terrain") return false;
    if (content.terrain === "wall") return false;
    if (hasStructureInRange(pos, STRUCTURE_STORAGE, 2, true)) return false;
    if (hasStructureInRange(pos, STRUCTURE_CONTROLLER, 2, true)) return false;
    if (hasStructureInRange(pos, STRUCTURE_LINK, 2, true)) return false;
    if (isWorkerSpot(pos)) return false;
  }
  if (pos.findInRange(FIND_SOURCES, 2).length) return false;
  return true;
}

function isWorkerSpot(pos: RoomPosition) {
  const spots = Memory.rooms[pos.roomName].upgradeSpots.concat(Memory.rooms[pos.roomName].harvestSpots);
  for (const spot of spots) {
    if (pos.x === spot.x && pos.y === spot.y) return true;
  }
  return false;
}

function getEnergy(object: Creep | AnyStructure | Resource | Ruin | Tombstone | Structure) {
  if (!object) return 0;
  const store = getStore(object);
  if (store) return store.getUsedCapacity(RESOURCE_ENERGY);
  if ("energy" in object) return object.energy;
  return 0;
}

function getStore(object: Creep | AnyStructure | Resource | Ruin | Tombstone | Structure) {
  if ("store" in object) return object.store;
  if ("getUsedCapacity" in object) return object;
  return;
}

function handleSpawn(spawn: StructureSpawn) {
  if (!spawn.spawning) {
    let roleToSpawn: Role;
    let body;
    let minBudget = 0;
    const controllersToReserve = getControllersToReserve();

    if (needCarriers()) {
      roleToSpawn = "carrier";
    } else if (needHarvesters(spawn.pos)) {
      spawnHarvester(spawn);
      return;
    } else if (controllersToReserve.length > 0) {
      spawnReserver(spawn, controllersToReserve[0]);
      return;
    } else if (needInfantry()) {
      roleToSpawn = "infantry";
    } else if (needAttackers(spawn.room)) {
      roleToSpawn = "attacker";
    } else if (getCreepCountByRole("explorer") <= 0) {
      roleToSpawn = "explorer";
      body = [MOVE];
    } else if (needWorkers(spawn.room)) {
      roleToSpawn = "worker";
      minBudget = Math.min(450, spawn.room.energyCapacityAvailable);
    } else {
      return;
    }

    const budget = getSpawnBudget(roleToSpawn, minBudget, spawn.room.energyCapacityAvailable);
    if (spawn.room.energyAvailable >= budget) {
      spawnCreep(spawn, roleToSpawn, budget, body, undefined);
    }
  }
}

function needInfantry() {
  if (!("attack" in Game.flags)) return false;
  return Memory.rooms[Game.flags.attack.pos.roomName].hostileRangedAttackParts > 0;
}

function needAttackers(room: Room) {
  return (
    "attack" in Game.flags &&
    room.energyAvailable >= room.energyCapacityAvailable &&
    getCreepCountByRole("attacker") < 5
  );
}

function spawnReserver(spawn: StructureSpawn, controllerToReserve: StructureController) {
  const minBudget = Math.max(1300, spawn.room.energyCapacityAvailable);
  if (minBudget > spawn.room.energyAvailable) return;
  if (spawn.room.energyAvailable >= minBudget) {
    const task: Task = { destination: controllerToReserve, action: "reserveController" };
    spawnCreep(spawn, "reserver", minBudget, undefined, task);
  }
}

function getDestructibleWallAt(pos: RoomPosition) {
  const walls = pos.lookFor(LOOK_STRUCTURES).filter(isDestructibleWall);
  if (walls.length && walls[0].destroy() === ERR_NOT_OWNER) return walls[0];
  return;
}

function updateFlagAttack() {
  logCpu("updateFlagAttack()");
  const flagAttack = Game.flags.attack;
  if (flagAttack) {
    if (
      flagAttack.room &&
      !getDestructibleWallAt(flagAttack.pos) &&
      getTargetsInRoom(flagAttack.room).length < 1
    ) {
      flagAttack.remove(); // have visibility to the room and it's clear of hostiles
    } else {
      logCpu("updateFlagAttack()");
      return; // current flag is still valid (to the best of our knowledge)
    }
  }
  // no flag, find new targets
  logCpu("updateFlagAttack() new");
  let targets: (Structure | Creep | PowerCreep)[] = [];
  for (const r in Game.rooms) {
    if (!shouldHarvestRoom(Game.rooms[r])) continue;
    logCpu("updateFlagAttack() targets");
    targets = targets.concat(getTargetsInRoom(Game.rooms[r]));
    logCpu("updateFlagAttack() targets");
  }
  const core = targets[Math.floor(Math.random() * targets.length)];
  if (core) core.pos.createFlag("attack", COLOR_CYAN, COLOR_BROWN);
  logCpu("updateFlagAttack() new");
  logCpu("updateFlagAttack()");
}

function updateFlagDismantle() {
  logCpu("updateFlagDismantle()");
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
    if (!shouldHarvestRoom(Game.rooms[r])) continue;
    if (Math.random() < 0.01) {
      const wall = getWallToDestroy(Game.rooms[r]);
      if (wall) {
        wall.pos.createFlag("dismantle", COLOR_BLUE, COLOR_BLUE);
        logCpu("updateFlagDismantle()");
        return;
      }
    }
  }
  logCpu("updateFlagDismantle()");
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
  if (!shouldHarvestRoom(room)) return;
  logCpu("getWallToDestroy(" + room.name + ")");
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
        logCpu("getWallToDestroy(" + room.name + ")");
        if (wall && wall.destroy() === ERR_NOT_OWNER) return wall;
      }
    }
  }
  logCpu("getWallToDestroy(" + room.name + ")");
  return;
}

function updateFlagReserve() {
  logCpu("updateFlagReserve()");
  const flagReserve = Game.flags.reserve;
  if (flagReserve) {
    if (flagReserve.room && !shouldReserveRoom(flagReserve.room)) {
      flagReserve.remove();
    } else {
      logCpu("updateFlagReserve()");
      return; // current flag is still valid
    }
  }
  const targets = getControllersToReserve();
  if (targets.length && targets[0]) targets[0].pos.createFlag("reserve", COLOR_ORANGE, COLOR_WHITE);
  logCpu("updateFlagReserve()");
}

function needWorkers(room: Room) {
  for (const i in Game.rooms) {
    if (
      Game.rooms[i]
        .find(FIND_MY_STRUCTURES)
        .filter(structure => structure.structureType === STRUCTURE_STORAGE && getEnergy(structure) < 100000)
        .length >= 1
    )
      return false;
  }
  return room.energyAvailable >= room.energyCapacityAvailable;
}

function getSpawnBudget(roleToSpawn: Role, minBudget: number, energyCapacityAvailable: number) {
  return Math.floor(
    Math.min(Math.max(getCostOfCurrentCreepsInTheRole(roleToSpawn), minBudget), energyCapacityAvailable)
  );
}

function getCostOfCurrentCreepsInTheRole(role: Role) {
  return (
    Object.values(Game.creeps).reduce(
      (aggregated, item) => aggregated + (item.memory.role === role ? getCreepCost(item) : 0),
      0 /* initial*/
    ) || 0
  );
}

function needHarvesters(pos: RoomPosition) {
  const source = getSourceToHarvest(pos);

  if (!source) return false; // nothing to harvest

  if (Memory.needHarvesters) return true;

  if (
    source.pos.findInRange(FIND_MY_STRUCTURES, 1).filter(target => target.structureType === STRUCTURE_LINK)
      .length > 0
  )
    return true; // always keep sources with link manned;

  for (const i in Game.rooms) {
    if (
      Game.rooms[i]
        .find(FIND_MY_STRUCTURES)
        .filter(structure => structure.structureType === STRUCTURE_STORAGE && getEnergy(structure) < 200000)
        .length >= 1
    )
      return true;
  }

  return false;
}

function getSourceToHarvest(pos: RoomPosition) {
  let sources: Source[] = [];
  for (const r in Game.rooms) {
    const room = Game.rooms[r];
    if (room.memory.hostilesPresent) continue;
    if (!canOperateInRoom(room)) continue;
    if (!shouldHarvestRoom(room)) continue;
    sources = sources.concat(
      room.find(FIND_SOURCES).filter(harvestSource => !sourceHasHarvester(harvestSource))
    );
  }
  if (sources.length < 1) return;
  let source = pos.findClosestByRange(sources); // same room
  if (source) return source;
  source = sources[Math.floor(Math.random() * sources.length)]; // another room
  return source;
}

function shouldHarvestRoom(room: Room) {
  if (!room) return false;
  if (room.controller?.my) return true;
  const exits = Game.map.describeExits(room.name);
  return (
    Object.values(exits).filter(roomName => Game.rooms[roomName] && Game.rooms[roomName].controller?.my)
      .length > 0
  );
}

function spawnHarvester(spawn: StructureSpawn) {
  const roleToSpawn: Role = "harvester"; // no energy for workers
  const source = getSourceToHarvest(spawn.pos);
  if (!source || !(source instanceof Source)) return;
  let body: BodyPartConstant[] = getBodyForHarvester(source);
  let cost = getBodyCost(body);
  if (cost > spawn.room.energyAvailable) {
    if (getCreepCountByRole("harvester") < 1) {
      body = body.filter((value, index, self) => self.indexOf(value) === index); /* unique */
      cost = getBodyCost(body);
      if (cost > spawn.room.energyAvailable) return false;
    } else {
      return false;
    }
  }
  const energyStructures: (StructureSpawn | StructureExtension)[] = getSpawnsAndExtensionsSorted(spawn.room);
  const name = getNameForCreep(roleToSpawn);
  const harvestPos = getHarvestSpotForSource(source);
  if (!harvestPos) return;
  constructContainerIfNeed(harvestPos);
  const memory = getInitialCreepMemory(roleToSpawn, source.id, spawn.pos, undefined);
  if (spawn.spawnCreep(body, name, { memory, energyStructures }) === OK) {
    Memory.needHarvesters = false;
    setDestinationFlag(name, harvestPos);
    spawnMsg(spawn, roleToSpawn, name, body, harvestPos.toString());
  }
  return true;
}

function getBodyForHarvester(source: Source) {
  const workParts = source.energyCapacity / ENERGY_REGEN_TIME / HARVEST_POWER;
  const body: BodyPartConstant[] = [CARRY];
  for (let x = 1; x <= workParts; x++) body.push(WORK);
  const moveParts = Math.ceil(body.length / 2); // 1:2 = 1/3 MOVE
  for (let x = 1; x <= moveParts; x++) body.push(MOVE);
  return body;
}

function getBodyPartRatio(body: BodyPartConstant[], type: BodyPartConstant = MOVE) {
  return body.filter(part => part === type).length / body.length;
}

function spawnMsg(
  spawn: StructureSpawn,
  roleToSpawn: Role,
  name: string,
  body: BodyPartConstant[],
  target: string | undefined
) {
  msg(
    spawn,
    "Spawning: " +
      roleToSpawn +
      " (" +
      name +
      "), cost: " +
      getBodyCost(body).toString() +
      "/" +
      spawn.room.energyAvailable.toString() +
      "/" +
      spawn.room.energyCapacityAvailable.toString() +
      (target ? " for " + target : "")
  );
}

function setDestinationFlag(name: string, pos: RoomPosition) {
  const color1 = COLOR_ORANGE;
  const color2 = COLOR_GREEN;
  const flagName = "creep_" + name;
  if (flagName in Game.flags) {
    const flag = Game.flags[flagName];
    flag.setPosition(pos); /* handles the first setColor or setPosition per tick! */
  } else {
    pos.createFlag(flagName, color1, color2);
  }
}

function getSpawnsAndExtensionsSorted(room: Room) {
  // First filled spawns/extensions should be used first, as they are probably easier to refill
  const all = room
    .find(FIND_MY_STRUCTURES)
    .filter(
      structure =>
        structure.structureType === STRUCTURE_EXTENSION || structure.structureType === STRUCTURE_SPAWN
    );

  return room.memory.sortedSpawnStructureIds
    .map(id => Game.getObjectById(id))
    .concat(
      all // random sorting
        .map(value => ({ value, sort: Math.random() }))
        .sort((a, b) => a.sort - b.sort)
        .map(({ value }) => value)
    )
    .filter((value, index, self) => self.indexOf(value) === index) // unique
    .filter(isSpawnOrExtension);
}

function getInitialCreepMemory(
  role: Role,
  sourceId: undefined | Id<Source>,
  pos: RoomPosition,
  task: Task | undefined
) {
  let destination;
  if (task?.destination && "id" in task?.destination) destination = task?.destination?.id;
  return {
    action: task?.action,
    awaitingDeliveryFrom: undefined, // Creep name
    build: undefined,
    destination,
    destinationSetTime: Game.time,
    empty: true,
    full: false,
    getEnergy: true,
    lastAction: undefined,
    lastActionOutcome: OK,
    lastBlockedIds: [],
    lastDestination: undefined,
    lastMoveTime: Game.time,
    lastOkActionTime: Game.time,
    posRevisits: 0,
    role,
    roomName: pos.roomName,
    sourceId,
    timeApproachedDestination: Game.time,
    timeOfLastEnergyReceived: Game.time,
    x: pos.x,
    y: pos.y
  };
}

function constructContainerIfNeed(harvestPos: RoomPosition) {
  if (
    harvestPos.lookFor(LOOK_STRUCTURES).filter(s => s.structureType !== STRUCTURE_ROAD).length <= 0 &&
    harvestPos.lookFor(LOOK_CONSTRUCTION_SITES).length <= 0 &&
    !hasStructureInRange(harvestPos, STRUCTURE_LINK, 1, true)
  ) {
    harvestPos.createConstructionSite(STRUCTURE_CONTAINER);
  }
}

function getHarvestSpotForSource(source: Source) {
  const room = Game.rooms[source.pos.roomName];
  let bestSpot;
  let bestScore = Number.NEGATIVE_INFINITY;
  const targetPos = source.pos;
  const range = 1;
  const terrain = new Room.Terrain(room.name);

  for (let x = targetPos.x - range; x <= targetPos.x + range; x++) {
    for (let y = targetPos.y - range; y <= targetPos.y + range; y++) {
      if (x === targetPos.x && y === targetPos.y) continue;
      if (terrain.get(x, y) === TERRAIN_MASK_WALL) continue;
      const pos = new RoomPosition(x, y, room.name);
      if (blockedByStructure(pos)) continue;
      const score =
        (hasStructureInRange(pos, STRUCTURE_LINK, 1, true) ? 1 : 0) +
        pos.lookFor(LOOK_STRUCTURES).filter(structure => structure.structureType === STRUCTURE_CONTAINER)
          .length +
        pos.findInRange(FIND_SOURCES, 1).length;
      if (bestScore < score) {
        bestScore = score;
        bestSpot = pos;
      }
    }
  }

  return bestSpot;
}

function sourceHasHarvester(source: Source) {
  for (const i in Game.creeps) {
    const creep = Game.creeps[i];
    if (creep.memory.sourceId === source.id) {
      return true;
    }
  }
  return false;
}

function getCreepCost(creep: Creep) {
  return getBodyCost(creep.body.map(part => part.type));
}

function needCarriers() {
  return getTotalCreepCapacity("carrier") < getTotalEnergyToHaul();
}

function getTotalEnergyToHaul() {
  let energy = 0;
  for (const i in Game.rooms) {
    if (Game.rooms[i].memory.hostilesPresent) continue;
    energy += Game.rooms[i]
      .find(FIND_STRUCTURES)
      .filter(structure => structure.structureType === STRUCTURE_CONTAINER)
      .reduce((aggregated, item) => aggregated + getEnergy(item), 0 /* initial*/);

    energy += Game.rooms[i]
      .find(FIND_DROPPED_RESOURCES)
      .reduce((aggregated, item) => aggregated + getEnergy(item), 0 /* initial*/);
  }
  return energy;
}

function getTotalCreepCapacity(role: Role | undefined) {
  return Object.values(Game.creeps).reduce(
    (aggregated, item) =>
      aggregated + (!role || item.memory.role === role ? item.store.getCapacity(RESOURCE_ENERGY) : 0),
    0 /* initial*/
  );
}

function spawnCreep(
  spawn: StructureSpawn,
  roleToSpawn: Role,
  energyAvailable: number,
  body: undefined | BodyPartConstant[],
  task: Task | undefined
) {
  if (!body) {
    if (roleToSpawn === "worker") body = getBodyForWorker(spawn.room.energyCapacityAvailable);
    else if (roleToSpawn === "carrier") body = getBodyForCarrier(energyAvailable);
    else if (roleToSpawn === "reserver") body = getBodyForReserver(Math.min(4800, energyAvailable));
    else if (roleToSpawn === "attacker") body = getBodyForAttacker(energyAvailable);
    else if (roleToSpawn === "infantry") body = getBodyForInfantry(energyAvailable);
  }
  const energyStructures = getSpawnsAndExtensionsSorted(spawn.room);
  const name = getNameForCreep(roleToSpawn);

  if (!body || getBodyCost(body) > spawn.room.energyAvailable) return;

  const outcome = spawn.spawnCreep(body, name, {
    memory: getInitialCreepMemory(roleToSpawn, undefined, spawn.pos, task),
    energyStructures
  });

  if (outcome === OK) {
    let targetStr;
    if (task) {
      targetStr = task.destination.toString();
      if ("pos" in task.destination) targetStr += " @ " + task.destination.pos.roomName;
    }
    spawnMsg(spawn, roleToSpawn, name, body, targetStr);
  } else {
    msg(spawn, "Failed to spawn creep: " + outcome.toString());
  }
}

function getBodyForWorker(energyAvailable: number) {
  const body: BodyPartConstant[] = [WORK, CARRY, MOVE];
  for (;;) {
    let nextPart: BodyPartConstant = WORK;
    if (getBodyPartRatio(body, MOVE) <= 0.34) nextPart = MOVE;
    else if (getBodyPartRatio(body, CARRY) <= 0.12) nextPart = CARRY;

    if (getBodyCost(body) + BODYPART_COST[nextPart] > energyAvailable) return body;
    body.push(nextPart);
    if (body.length >= 50) return body;
  }
}
function getBodyForCarrier(energyAvailable: number) {
  const body: BodyPartConstant[] = [CARRY, MOVE];
  for (;;) {
    const nextPart = getBodyPartRatio(body) <= 0.34 ? MOVE : CARRY;
    if (getBodyCost(body) + BODYPART_COST[nextPart] > energyAvailable) return body;
    body.push(nextPart);
    if (body.length >= 50) return body;
  }
}
function getBodyForReserver(energyAvailable: number) {
  const body: BodyPartConstant[] = [CLAIM, MOVE];
  for (;;) {
    const nextPart = getBodyPartRatio(body) <= 0.34 ? MOVE : CLAIM;
    if (getBodyCost(body) + BODYPART_COST[nextPart] > energyAvailable) return body;
    body.push(nextPart);
    if (body.length >= 50) return body;
  }
}
function getBodyForAttacker(energyAvailable: number) {
  const body: BodyPartConstant[] = [ATTACK, MOVE];
  for (;;) {
    const nextPart = getBodyPartRatio(body) <= 0.34 ? MOVE : ATTACK;
    if (getBodyCost(body) + BODYPART_COST[nextPart] > energyAvailable) return body;
    body.push(nextPart);
    if (body.length >= 50) return body;
  }
}
function getBodyForInfantry(energyAvailable: number) {
  const body: BodyPartConstant[] = [MOVE, RANGED_ATTACK];
  for (;;) {
    const nextPart = getBodyPartRatio(body) <= 0.34 ? MOVE : RANGED_ATTACK;
    if (getBodyCost(body) + BODYPART_COST[nextPart] > energyAvailable) return body;
    body.push(nextPart);
    if (body.length >= 50) return body;
  }
}

function msg(
  context: StructureSpawn | AnyStructure | Room | Creep | RoomPosition | string | Flag,
  text: string,
  email = false
) {
  if (!text) return;
  const finalMsg = Game.time.toString() + " " + context.toString() + ": " + text;
  console.log(finalMsg);
  if (email) Game.notify(finalMsg);
}

function getNameForCreep(role: Role) {
  const characters = "ABCDEFHJKLMNPQRTUVWXYZ234789";
  let name = role.substring(0, 1).toUpperCase();
  while (Game.creeps[name]) {
    name += characters.charAt(Math.floor(Math.random() * characters.length));
  }
  return name;
}

function construct(room: Room, structureType: BuildableStructureConstant) {
  if (needStructure(room, structureType)) {
    const pos = getPosForConstruction(room, structureType);
    if (!pos) return;
    if (structureType !== STRUCTURE_ROAD) {
      pos.lookFor(LOOK_STRUCTURES).forEach(existingStructure => {
        if (existingStructure instanceof StructureExtension) {
          msg(existingStructure, "Destroying to make space for: " + structureType, true);
          existingStructure.destroy();
        }
      });
    }
    const outcome = pos.createConstructionSite(structureType);
    msg(
      room,
      "Creating a construction site for " +
        structureType +
        " at " +
        pos.toString() +
        " outcome: " +
        outcome.toString()
    );
    if (structureType === STRUCTURE_LINK) {
      pos
        .findInRange(FIND_STRUCTURES, 1)
        .filter(target => target.structureType === STRUCTURE_CONTAINER)
        .forEach(structure => {
          msg(structure, "This container is being replaced by a link");
          structure.destroy();
        });
    }
  }
}

function needStructure(room: Room, structureType: BuildableStructureConstant) {
  if (!room.controller) return false; // no controller
  if (!room.controller.my && room.controller.owner) return false; // owned by others
  const targetCount = CONTROLLER_STRUCTURES[structureType][room.controller.level];
  return targetCount > getStructureCount(room, structureType, true);
}

function getStructureCount(room: Room, structureType: StructureConstant, includeConstructionSites: boolean) {
  let count = room
    .find(FIND_MY_STRUCTURES)
    .filter(structure => structure.structureType === structureType).length;
  if (includeConstructionSites) {
    count += room
      .find(FIND_MY_CONSTRUCTION_SITES)
      .filter(structure => structure.structureType === structureType).length;
  }
  return count;
}

function getCreepCountByRole(role: Role, inactiveOnly = false, minTicksToLive = 120) {
  return Object.values(Game.creeps).filter(function (creep) {
    return (
      creep.memory.role === role &&
      (!inactiveOnly || creep.memory.lastActionOutcome !== OK) &&
      (!creep.ticksToLive || creep.ticksToLive >= minTicksToLive)
    );
  }).length;
}

function getBodyCost(body: BodyPartConstant[]) {
  return body.reduce(function (cost, part) {
    return cost + BODYPART_COST[part];
  }, 0);
}

function resetDestination(creep: Creep) {
  logCpu("resetDestination(" + creep.name + ")");
  // save last values
  creep.memory.lastDestination = creep.memory.destination;
  creep.memory.lastAction = creep.memory.action;
  // reset properties
  logCpu("resetDestination(" + creep.name + ")");
  if (!creep.memory.destination) return;
  let destination;
  if (!(creep.memory.destination instanceof RoomPosition))
    destination = Game.getObjectById(creep.memory.destination);
  creep.memory.destination = undefined;
  creep.memory.destinationSetTime = Game.time;
  creep.memory.action = undefined;
  creep.memory.posRevisits = 0;
  if (destination && "memory" in destination && "awaitingDeliveryFrom" in destination.memory) {
    destination.memory.awaitingDeliveryFrom = undefined;
  }
  const flag = Game.flags["creep_" + creep.name];
  if (flag) flag.remove();
  logCpu("resetDestination(" + creep.name + ")");
  return;
}

function isEmpty(object: Structure | Creep) {
  if (!object) return false;
  const store = getStore(object);
  if (!store) return false;
  return store.getUsedCapacity(RESOURCE_ENERGY) <= 0;
}
function hasSpace(object: Structure | Creep) {
  if (!object) return false;
  const store = getStore(object);
  if (!store) return false;
  return store.getFreeCapacity(RESOURCE_ENERGY) > 0;
}
function isFull(object: Structure | Creep) {
  if (!object) return false;
  const store = getStore(object);
  if (!store) return false;
  return store.getFreeCapacity(RESOURCE_ENERGY) <= 0;
}
function getFillRatio(object: Structure | Creep) {
  if (!object) return 0;
  const store = getStore(object);
  if (!store) return 0;
  return store.getUsedCapacity(RESOURCE_ENERGY) / store.getCapacity(RESOURCE_ENERGY);
}

function hexToHSL(hex: string) {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!result) return;
  let r = parseInt(result[1], 16);
  let g = parseInt(result[2], 16);
  let b = parseInt(result[3], 16);
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h;
  let s;
  const l = (max + min) / 2;
  if (max === min) {
    h = s = 0; // achromatic
  } else {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r:
        h = (g - b) / d + (g < b ? 6 : 0);
        break;
      case g:
        h = (b - r) / d + 2;
        break;
      case b:
        h = (r - g) / d + 4;
        break;
    }
    if (h) h /= 6;
  }
  return { h, s, l };
}
