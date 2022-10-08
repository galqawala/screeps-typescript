// When compiling TS to JS and bundling with rollup, the line numbers and file names in error messages change
// This utility uses source maps to get the line numbers and file names of the original, TS source code
import { ErrorMapper } from "utils/ErrorMapper";
import { Md5 } from "ts-md5";

declare global {
  type Role = "attacker" | "carrier" | "explorer" | "harvester" | "reserver" | "worker";
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
    username: string;
    needHarvesters: boolean;
    time: Record<number, TimeMemory>;
    cpuLog: Record<string, CpuLogEntry>;
  }

  interface FlagMemory {
    steps: number;
    initTime: number;
  }

  interface TimeMemory {
    getTotalEnergyToHaul: number;
  }

  interface RoomMemory {
    canHarvest: boolean;
    constructionSiteCount: number;
    constructionSiteScore: number[][];
    energyAvailable: number;
    harvestSpots: RoomPosition[];
    hostilesPresent: boolean;
    lastTimeSpawnsFull: number;
    sortedSpawnStructureIds: Id<Structure>[];
    status: "normal" | "closed" | "novice" | "respawn";
    structureCount: number;
    timeOfLastSpawnEnergyDelivery: number;
    upgradeSpots: RoomPosition[];
  }

  interface CreepMemory {
    role: Role;
    sourceId: undefined | Id<Source>;
    empty: boolean;
    full: boolean;
    timeOfLastEnergyReceived: number;
    lastOkActionTime: number;
    x: number;
    y: number;
    roomName: string;
    lastMoveTime: number;
    destinationSetTime: number;
    destination: undefined | DestinationId | RoomPosition;
    lastDestination: undefined | DestinationId | RoomPosition;
    action: undefined | Action;
    lastAction: undefined | Action;
    lastActionOutcome: ScreepsReturnCode;
    lastBlockedIds: DestinationId[];
    awaitingDeliveryFrom: undefined | string; // Creep name
    posRevisits: number;
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

const minRoadTraffic = 0.014;

function logCpu(name: string) {
  if (!Memory.cpuLog) Memory.cpuLog = {};

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
function isLink(structure: Structure): structure is StructureLink {
  return structure.structureType === STRUCTURE_LINK;
}
function isTower(structure: Structure): structure is StructureTower {
  return structure.structureType === STRUCTURE_TOWER;
}
function isInvaderCore(structure: Structure): structure is StructureInvaderCore {
  return structure.structureType === STRUCTURE_INVADER_CORE;
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
  const memLimit = 500;
  if (Object.keys(Memory.time).length > memLimit) purgeTimeMemory();
  if (Object.keys(Memory.flags).length > memLimit) purgeFlagsMemory();
  if (Object.keys(Game.flags).length > memLimit) purgeFlags();
  if (!Memory.username) setUsername();

  updateFlagAttack();
  updateFlagReserve();

  for (const c in Game.creeps) {
    logCpu("creep: " + c);
    const role = Game.creeps[c].memory.role;

    if (role === "attacker") handleAttacker(Game.creeps[c]);
    else if (role === "carrier") handleCarrier(Game.creeps[c]);
    else if (role === "explorer") handleExplorer(Game.creeps[c]);
    else if (role === "harvester") handleHarvester(Game.creeps[c]);
    else if (role === "reserver") handleReserver(Game.creeps[c]);
    else if (role === "worker") handleWorker(Game.creeps[c]);

    logCpu("creep: " + c);
  }
  for (const s in Game.spawns) handleSpawn(Game.spawns[s]);
  for (const r in Game.rooms) handleRoom(Game.rooms[r]);

  if (!Memory.time) Memory.time = {};
  if (!(Game.time in Memory.time)) Memory.time[Game.time] = { getTotalEnergyToHaul: getTotalEnergyToHaul() };
  cpuInfo();
});

function handleExplorer(creep: Creep) {
  if (!moveTowardMemory(creep)) {
    const destination = getExit(creep.pos, !creep.ticksToLive || creep.ticksToLive > 300, false);
    if (destination) {
      move(creep, destination);
      setDestination(creep, destination);
    }
  }
}

function handleWorker(creep: Creep) {
  if (creep.memory.awaitingDeliveryFrom) {
    if (isEdge(creep.pos)) move(creep, getRandomPos(creep.pos.roomName)); // move once towards a random position
  } else if (isEmpty(creep)) {
    const sources = getEnergySourcesForWorker(creep);
    let destination = creep.pos.findClosestByRange(sources); // same room
    if (!destination) destination = sources[Math.floor(Math.random() * sources.length)]; // another room
    if (destination instanceof RoomPosition) {
      move(creep, destination);
    } else if (destination instanceof Source && creep.harvest(destination) === ERR_NOT_IN_RANGE) {
      if (move(creep, destination) === OK) creep.harvest(destination);
    } else if (!(destination instanceof Source) && retrieveEnergy(creep, destination) === ERR_NOT_IN_RANGE) {
      move(creep, destination);
      if (retrieveEnergy(creep, destination) === ERR_NOT_IN_RANGE) setDestination(creep, destination);
    }
  } else if (!isEmpty(creep)) {
    return upgrade(creep, true) || repair(creep) || build(creep) || upgrade(creep, false);
  }
  return;
}

function build(creep: Creep) {
  const destinations = getConstructionSites(creep);
  let destination = creep.pos.findClosestByRange(destinations); // same room
  if (!destination) destination = destinations[Math.floor(Math.random() * destinations.length)]; // another room
  if (destination && creep.build(destination) === ERR_NOT_IN_RANGE) {
    if (move(creep, destination) === OK) creep.build(destination);
    flagEnergyConsumer(destination.pos);
    return true;
  }
  return false;
}

function repair(creep: Creep) {
  const repairTarget = getRepairTarget(creep);
  if (repairTarget && creep.repair(repairTarget) === ERR_NOT_IN_RANGE) {
    if (move(creep, repairTarget) === OK) creep.repair(repairTarget);
    flagEnergyConsumer(repairTarget.pos);
    return true;
  }
  return false;
}

function upgrade(creep: Creep, urgentOnly: boolean) {
  const controller = getControllerToUpgrade(creep.pos, urgentOnly);
  if (controller && creep.upgradeController(controller) === ERR_NOT_IN_RANGE) {
    if (move(creep, controller) === OK) creep.upgradeController(controller);
    flagEnergyConsumer(controller.pos);
    return true;
  }
  return false;
}

function getRepairTarget(creep: Creep) {
  logCpu("getRepairTarget(" + creep.name + ")");
  const destinations: Structure[] = creep.pos
    .findInRange(FIND_STRUCTURES, 10) /* limited range to improve performance */
    .filter(target => worthRepair(creep.pos, target) && !isUnderRepair(target) && !isBlocked(creep, target));

  let destination = creep.pos.findClosestByRange(destinations); // same room
  if (!destination) destination = destinations[Math.floor(Math.random() * destinations.length)]; // another room
  logCpu("getRepairTarget(" + creep.name + ")");
  return destination;
}

function getControllerToUpgrade(pos: RoomPosition, urgentOnly: boolean) {
  logCpu("getControllerToUpgrade()");
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
  logCpu("getControllerToUpgrade()");
  return destination;
}

function getEnergySourcesForWorker(creep: Creep) {
  let sources: (EnergySource | RoomPosition | Source)[] = [];
  for (const i in Game.rooms) {
    if (Game.rooms[i].memory.hostilesPresent) continue;
    sources = sources.concat(
      getEnergyInRoom(
        Game.rooms[i],
        getMinTransferAmount(creep),
        creep.pos,
        true,
        true,
        getCreepCountByRole("harvester") < 1
      )
    );
  }
  return sources;
}

function cpuInfo() {
  if (Game.cpu.getUsed() > Game.cpu.limit) {
    msg(
      "cpuInfo()",
      Game.cpu.getUsed().toString() + "/" + Game.cpu.limit.toString() + " CPU used!\n" + getCpuLog()
    );
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
  let upstream;
  let downstream;
  if (!isFull(creep)) {
    let sources: EnergySource[] = [];
    for (const i in Game.rooms) {
      if (Game.rooms[i].memory.hostilesPresent) continue;
      sources = sources.concat(getEnergyInRoomForCarrier(Game.rooms[i], getMinTransferAmount(creep)));
    }
    upstream = creep.pos.findClosestByRange(sources); // same room
    if (!upstream) upstream = sources[Math.floor(Math.random() * sources.length)]; // another room
  }
  if (!isEmpty(creep)) {
    const destinations = getEnergyDestinations();
    downstream = creep.pos.findClosestByRange(destinations); // same room
    if (!downstream) downstream = destinations[Math.floor(Math.random() * destinations.length)]; // another room
  }
  if (upstream && (!downstream || creep.pos.getRangeTo(downstream) >= creep.pos.getRangeTo(upstream))) {
    if (retrieveEnergy(creep, upstream) === ERR_NOT_IN_RANGE) {
      move(creep, upstream);
      if (retrieveEnergy(creep, upstream) === ERR_NOT_IN_RANGE) setDestination(creep, upstream);
    }
  } else if (downstream) {
    if (transfer(creep, downstream) === ERR_NOT_IN_RANGE) {
      move(creep, downstream);
      if (transfer(creep, downstream) === ERR_NOT_IN_RANGE) setDestination(creep, downstream);
    }
  }
}

function getEnergyInRoomForCarrier(room: Room, myMinTransfer: number) {
  let sources: EnergySource[] = room
    .find(FIND_DROPPED_RESOURCES)
    .filter(resource => getEnergy(resource) >= myMinTransfer);
  sources = sources.concat(room.find(FIND_TOMBSTONES).filter(tomb => getEnergy(tomb) >= myMinTransfer));
  sources = sources.concat(room.find(FIND_RUINS).filter(ruin => getEnergy(ruin) >= myMinTransfer));
  sources = sources.concat(
    room
      .find(FIND_STRUCTURES)
      .filter(isContainerLinkOrStorage)
      .filter(
        structure =>
          (structure.structureType === STRUCTURE_CONTAINER || isDownstreamLink(structure)) &&
          getEnergy(structure) >= myMinTransfer
      )
  );
  return sources;
}

function handleReserver(creep: Creep) {
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
      creep.room.memory.timeOfLastSpawnEnergyDelivery = Game.time;
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
  const bestTarget = getTarget(creep);
  if (bestTarget) {
    if (engageTarget(creep, bestTarget) === ERR_NOT_IN_RANGE) {
      move(creep, bestTarget);
      engageTarget(creep, bestTarget);
    }
  } else {
    const flag = Game.flags.attack;
    if (flag) {
      move(creep, flag);
    } else {
      recycleCreep(creep);
    }
  }
}

function purgeTimeMemory() {
  logCpu("purgeTimeMemory()");
  let remove = true;
  for (const time in Memory.time) {
    if (remove) delete Memory.time[time];
    remove = !remove;
  }
  logCpu("purgeTimeMemory()");
}

function setUsername() {
  // room controllers
  for (const r in Game.rooms) {
    const room = Game.rooms[r];
    if (room.controller && room.controller.my && room.controller.owner) {
      Memory.username = room.controller.owner.username;
      return;
    }
  }
  // creeps
  const creeps = Object.values(Game.creeps);
  if (creeps.length) {
    Memory.username = creeps[0].owner.username;
    return;
  }
}

function getControllersToReserve() {
  const controllers = [];
  for (const r in Game.rooms) {
    const controller = Game.rooms[r].controller;
    if (controller && shouldReserveRoom(Game.rooms[r]) && !creepsHaveDestination(controller)) {
      controllers.push(controller);
    }
  }
  return controllers
    .map(value => ({ value, sort: value?.reservation?.ticksToEnd || 0 }))
    .sort((a, b) => a.sort - b.sort)
    .map(({ value }) => value);
}

function creepsHaveDestination(structure: Structure) {
  if (!structure) return false;
  if (!structure.id) return false;
  if (
    Object.values(Game.creeps).filter(function (creep) {
      return creep.memory.destination === structure.id;
    }).length
  )
    return true;
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
  logCpu("handleHarvester()");
  if (creep.memory.role !== "harvester") return false;
  if (creep.spawning) return true;
  if (creep.memory.action === "recycleCreep") {
    recycleCreep(creep);
    return true;
  }
  // move
  const flagName = "creep_" + creep.name;
  if (flagName in Game.flags) {
    const flag = Game.flags[flagName];
    move(creep, flag);
  }
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
  logCpu("handleHarvester()");
  return true;
}

function harvesterSpendEnergy(creep: Creep) {
  const target = creep.pos.findClosestByRange(creep.pos.findInRange(FIND_STRUCTURES, 3).filter(needRepair));
  if (target) creep.repair(target);
  // build
  const site = creep.pos.findClosestByRange(creep.pos.findInRange(FIND_MY_CONSTRUCTION_SITES, 3));
  if (site) creep.build(site);
  // upgrade controller
  if (creep.room.controller) creep.upgradeController(creep.room.controller);
  // transfer
  if (isFull(creep)) unloadCreep(creep);
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
  const towers = room.find(FIND_MY_STRUCTURES).filter(isTower);
  for (const t of towers) {
    const bestTarget = getTarget(t);
    if (!bestTarget) break; // no targets in this room for any tower
    engageTarget(t, bestTarget);
  }

  handleHostilesInRoom(room);

  if (canOperateInRoom(room) && Math.random() < 0.1) constructInRoom(room);

  // handle the links
  handleLinks(room);

  if (!room.memory.upgradeSpots) updateUpgradeSpots(room);
  if (!room.memory.harvestSpots) updateHarvestSpots(room);

  // check the room details
  checkRoomStatus(room);
  checkRoomCanHarvest(room);
  checkRoomEnergy(room);
  logCpu("handleRoom(" + room.name + ")");
}

function constructInRoom(room: Room) {
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
}

function checkRoomStatus(room: Room) {
  const value = getRoomStatus(room.name);
  if (room.memory.status !== value) {
    msg(room, "Status: " + room.memory.status + " ➤ " + value.toString(), true);
    room.memory.status = value;
  }
}

function checkRoomCanHarvest(room: Room) {
  const value = canOperateInRoom(room);
  if (room.memory && room.memory.canHarvest !== value) {
    msg(
      room,
      "Can harvest: " + (room.memory.canHarvest || "-").toString() + " ➤ " + (value || "-").toString(),
      true
    );
    room.memory.canHarvest = value;
  }
}

function checkRoomEnergy(room: Room) {
  const energy = room.energyAvailable;
  if (room.memory.energyAvailable > energy) {
    tryResetSpawnsAndExtensionsSorting(room);
  } else if (room.energyAvailable >= room.energyCapacityAvailable) {
    room.memory.lastTimeSpawnsFull = Game.time;
  }
  room.memory.energyAvailable = energy;
}

function handleHostilesInRoom(room: Room) {
  // check for presence of hostiles
  const hostileCreeps = room.find(FIND_HOSTILE_CREEPS);
  const hostilePowerCreeps = room.find(FIND_HOSTILE_POWER_CREEPS);
  const totalHostiles = hostileCreeps.length + hostilePowerCreeps.length;
  const hostilesPresent = totalHostiles > 0;

  if (room.memory.hostilesPresent !== hostilesPresent) {
    if (hostilesPresent) {
      const hostileOwners = hostileCreeps
        .map(creep => creep.owner.username)
        .concat(hostilePowerCreeps.map(creep => creep.owner.username))
        .filter((value, index, self) => self.indexOf(value) === index); // unique
      msg(room, totalHostiles.toString() + " hostiles from " + hostileOwners.join() + " detected!", true);
    } else {
      msg(room, "clear from hostiles =)", true);
    }
    room.memory.hostilesPresent = hostilesPresent;
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
  const flagName = room.name + "_EnergyConsumer";
  if (!(flagName in Game.flags)) return;
  const flag = Game.flags[flagName];
  const destination = flag.pos;
  if (getCreepCountByRole("worker", false, 0) < 1) {
    // move energy toward storage when we have no workers
    const storages = room
      .find(FIND_STRUCTURES)
      .filter(structure => structure.structureType === STRUCTURE_STORAGE);
    if (storages.length) return storages[0].pos;
  }
  return destination;
}

function handleLinks(room: Room) {
  // move energy towards the energy consumer
  const downstreamPos = getLinkDownstreamPos(room);
  if (!downstreamPos) return;

  const links = room
    .find(FIND_MY_STRUCTURES)
    .filter(isLink)
    .map(value => ({ value, sort: value.pos.getRangeTo(downstreamPos) })) /* persist sort values */
    .sort((a, b) => b.sort - a.sort) /* sort */
    .map(({ value }) => value); /* remove sort values */
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
    }
  }
}

function canAttack(myUnit: StructureTower | Creep) {
  if (myUnit instanceof StructureTower) return true;
  if (myUnit.getActiveBodyparts(ATTACK) > 0) return true;
  return false;
}
function canHeal(myUnit: StructureTower | Creep) {
  if (myUnit instanceof StructureTower) return true;
  if (myUnit.getActiveBodyparts(HEAL) > 0) return true;
  return false;
}
function canRepair(myUnit: StructureTower | Creep) {
  if (myUnit instanceof StructureTower) return true;
  if (myUnit.getActiveBodyparts(WORK) > 0) return true;
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
  let bestTarget;
  let bestTargetScore = Number.NEGATIVE_INFINITY;
  const structures = myUnit.room
    .find(FIND_STRUCTURES)
    .filter(
      target =>
        target.hitsMax > 0 &&
        ((!isEnemy(target) && canRepair(myUnit) && needRepair(target) && target.hits < target.hitsMax / 2) ||
          (isEnemy(target) && canAttack(myUnit)))
    );
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
  if (isEnemy(target)) {
    return myUnit.attack(target);
  } else if (target instanceof Creep || target instanceof PowerCreep) {
    return myUnit.heal(target);
  } else {
    return myUnit.repair(target);
  }
}

function getTarget(myUnit: StructureTower | Creep) {
  const creep = getTargetCreep(myUnit);
  const powerCreep = getTargetPowerCreep(myUnit);
  const structure = getTargetStructure(myUnit);

  const targets = [];
  if (creep) targets.push(creep);
  if (powerCreep) targets.push(powerCreep);
  if (structure) targets.push(structure);

  if (targets.length < 1) return;
  return targets.sort((a, b) => b.score - a.score)[0].target;
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

function posEquals(a: RoomPosition, b: RoomPosition) {
  if (!a || !b) return false;
  return a.x === b.x && a.y === b.y && a.roomName === b.roomName;
}

function setDestination(creep: Creep, destination: Destination) {
  if (destination && creep.memory.destination !== ("id" in destination ? destination.id : destination)) {
    if ("id" in destination) {
      creep.memory.destination = destination.id;
      creep.memory.destinationSetTime = Game.time;
    } else if (destination instanceof RoomPosition) {
      creep.memory.destination = destination;
      creep.memory.destinationSetTime = Game.time;
    }
  }
  if ("pos" in destination) setDestinationFlag(creep.name, destination.pos);
  else if (destination instanceof RoomPosition) setDestinationFlag(creep.name, destination);
}

function getEnergyDestinations() {
  logCpu("getEnergyDestinations()");
  let targets: Structure[] = [];

  for (const i in Game.rooms) {
    const room = Game.rooms[i];
    if (room.memory.hostilesPresent) continue;
    let roomTargets = room
      .find(FIND_MY_STRUCTURES)
      .filter(structure => structure.structureType === STRUCTURE_TOWER && !isFull(structure));
    if (roomTargets.length < 1) {
      roomTargets = room
        .find(FIND_MY_STRUCTURES)
        .filter(
          structure =>
            !isFull(structure) &&
            (isLink(structure) ||
              (structure.structureType === STRUCTURE_STORAGE && shouldFillStorage(room)) ||
              isSpawnOrExtension(structure)) &&
            !isDownstreamLink(structure)
        );
    }
    if (roomTargets.length < 1) {
      roomTargets = getEnergyStructures(room);
    }
    targets = targets.concat(roomTargets);
  }
  logCpu("getEnergyDestinations()");

  return targets;
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

function getEnergyInRoom(
  room: Room,
  myMinTransfer: number,
  pos: RoomPosition,
  allowStorage = true,
  allowAnyLink = true,
  allowSource = true
) {
  let sources: (EnergySource | RoomPosition | Source)[] = room
    .find(FIND_DROPPED_RESOURCES)
    .filter(resource => getEnergy(resource) >= myMinTransfer);
  sources = sources.concat(room.find(FIND_TOMBSTONES).filter(tomb => getEnergy(tomb) >= myMinTransfer));
  sources = sources.concat(room.find(FIND_RUINS).filter(ruin => getEnergy(ruin) >= myMinTransfer));
  sources = sources.concat(
    room
      .find(FIND_STRUCTURES)
      .filter(isContainerLinkOrStorage)
      .filter(
        structure =>
          (structure.structureType === STRUCTURE_CONTAINER ||
            (structure.structureType === STRUCTURE_STORAGE && allowStorage) ||
            (isLink(structure) && allowAnyLink) ||
            isDownstreamLink(structure)) &&
          getEnergy(structure) >= myMinTransfer
      )
  );
  if (allowSource && canOperateInRoom(room)) {
    const activeSources = pos.findInRange(FIND_SOURCES_ACTIVE, 1);
    if (activeSources.length) {
      sources = sources.concat(activeSources);
    } else {
      sources = sources.concat(getAvailableHarvestSpots(room));
    }
  }
  return sources;
}

function move(creep: Creep, destination: Destination) {
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
    updateConstructionSiteScoreForCreep(creep);
  }
  return creep.moveTo(destination, {
    visualizePathStyle: { stroke: getHashColor(creep.memory.role) }
  });
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

function worthRepair(pos: RoomPosition, structure: Structure) {
  if (!needRepair(structure)) return false;
  let maxHpRatio = 1 - (pos.getRangeTo(structure) - 5) / 100;
  if ((maxHpRatio || 0) < 0.5) maxHpRatio = 0.5;
  if (structure.hits / structure.hitsMax > maxHpRatio) return false;
  return true;
}

function isDownstreamLink(link: Structure) {
  if (isLink(link)) {
    return hasStructureInRange(link.pos, STRUCTURE_CONTROLLER, 6, false);
  }
  return false;
}

function getAvailableHarvestSpots(room: Room) {
  const spots = room.memory.harvestSpots;
  const availableSpots: RoomPosition[] = [];

  spots.forEach(spot => {
    const pos = new RoomPosition(spot.x, spot.y, spot.roomName);
    if (
      pos.findInRange(FIND_SOURCES_ACTIVE, 1).length >= 1 &&
      pos.lookFor(LOOK_CREEPS).length < 1 &&
      !creepsOnWayToPos(pos)
    ) {
      availableSpots.push(pos);
    }
  });

  return availableSpots;
}

function creepsOnWayToPos(pos: RoomPosition) {
  for (const i in Game.creeps) {
    const creep = Game.creeps[i];
    const destination = creep.memory.destination;
    if (destination instanceof RoomPosition && posEquals(destination, pos)) return true;
  }
  const flags = pos.lookFor(LOOK_FLAGS);
  for (const flag of flags) {
    if (!flag.name.startsWith("creep_")) continue;
    if (flag.name.substring(6) in Game.creeps) return true;
  }
  return false;
}

function getRandomPos(roomName: string) {
  const x = Math.floor(Math.random() * 10);
  const y = Math.floor(Math.random() * 10);
  return new RoomPosition(x, y, roomName);
}

function flagEnergyConsumer(pos: RoomPosition) {
  logCpu("flagEnergyConsumer(" + pos.toString() + ")");
  const flagName = pos.roomName + "_EnergyConsumer";
  if (flagName in Game.flags) {
    const flag = Game.flags[flagName];
    flag.setPosition(pos); /* handles the first setColor or setPosition per tick! */
  } else {
    pos.createFlag(flagName, COLOR_BLUE, COLOR_PURPLE);
  }
  logCpu("flagEnergyConsumer(" + pos.toString() + ")");
}

function getConstructionSites(creep: Creep) {
  let sites: ConstructionSite[] = [];
  for (const i in Game.rooms) {
    const room = Game.rooms[i];
    if (room.memory.hostilesPresent) continue;
    sites = sites.concat(room.find(FIND_MY_CONSTRUCTION_SITES).filter(target => !isBlocked(creep, target)));
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

function getMinTransferAmount(creep: Creep) {
  return creep.store.getCapacity(RESOURCE_ENERGY) / 10;
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

function getEnergyStructures(room: Room) {
  return room
    .find(FIND_MY_STRUCTURES)
    .filter(
      structure =>
        (structure.structureType === STRUCTURE_EXTENSION || structure.structureType === STRUCTURE_SPAWN) &&
        !isFull(structure)
    );
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

function isAccessBetweenRooms(aRoomName: string, bRoomName: string) {
  if (getRoomStatus(aRoomName) !== "novice" && getRoomStatus(bRoomName) !== "novice") return true;
  if (getRoomStatus(aRoomName) === "novice" && getRoomStatus(bRoomName) === "novice") return true;
  return false;
}

function getExit(pos: RoomPosition, safeOnly = true, harvestableOnly = true) {
  if (!pos) return;
  const exits = Game.map.describeExits(pos.roomName);
  const accessibleRooms = Object.values(exits).filter(
    roomName =>
      (!safeOnly || isRoomSafe(roomName)) &&
      (!harvestableOnly || Memory.rooms[roomName].canHarvest) &&
      isAccessBetweenRooms(roomName, pos.roomName)
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

function updateConstructionSiteScoreForCreep(creep: Creep) {
  const creepX = creep.pos.x;
  const creepY = creep.pos.y;
  // lower the score for the occupied position and increase the score in the surrounding positions
  // the sum of the changes should add up to 0
  for (let x = creepX - 1; x <= creepX + 1; x++) {
    for (let y = creepY - 1; y <= creepY + 1; y++) {
      const value = creepX === x && creepY === y ? -8 : +1;
      updateConstructionSiteScore(creep.room, x, y, value);
    }
  }
}

function updateConstructionSiteScore(room: Room, x: number, y: number, value: number) {
  if (!room.memory.constructionSiteScore) room.memory.constructionSiteScore = [];
  if (!room.memory.constructionSiteScore[x]) room.memory.constructionSiteScore[x] = [];
  if (!room.memory.constructionSiteScore[x][y]) room.memory.constructionSiteScore[x][y] = 0;
  if (value) room.memory.constructionSiteScore[x][y] += value;
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
  const scores = room.memory.constructionSiteScore;
  const sites: ScoredPos[] = [];

  for (let x = 2; x <= 47; x++) {
    for (let y = 2; y <= 47; y++) {
      if ((x + y) % 2 === 1) continue; // build in a checkered pattern to allow passage
      updateConstructionSiteScore(room, x, y, 0);
      const pos = room.getPositionAt(x, y);
      if (!pos) continue;
      if (!isPosSuitableForConstruction(pos)) continue;
      const score = scores[x][y];
      if (!score) continue;
      const scoredPos: ScoredPos = { score, pos };
      if (!scoredPos) continue;
      sites.push(scoredPos);
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
    } else if ("attack" in Game.flags) {
      roleToSpawn = "attacker";
      minBudget = Math.min(260, spawn.room.energyCapacityAvailable);
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

function spawnReserver(spawn: StructureSpawn, controllerToReserve: StructureController) {
  const minBudget = Math.max(1300, spawn.room.energyCapacityAvailable);
  if (minBudget > spawn.room.energyAvailable) return;
  msg(spawn, "spawning a reserver for " + minBudget.toString());
  if (spawn.room.energyAvailable >= minBudget) {
    const task: Task = { destination: controllerToReserve, action: "reserveController" };
    spawnCreep(spawn, "reserver", minBudget, undefined, task);
  }
}

function updateFlagAttack() {
  const flagAttack = Game.flags.attack;
  if (flagAttack) {
    if (flagAttack.room && flagAttack.room.find(FIND_HOSTILE_STRUCTURES).filter(isInvaderCore).length < 1) {
      flagAttack.remove();
    } else {
      return; // current flag is still valid
    }
  }
  let targets: (StructureInvaderCore | Creep | PowerCreep)[] = [];
  for (const r in Game.rooms) {
    targets = targets.concat(Game.rooms[r].find(FIND_HOSTILE_STRUCTURES).filter(isInvaderCore));
    targets = targets.concat(
      Game.rooms[r].find(FIND_HOSTILE_CREEPS).filter(target => target.owner.username === "Invader")
    );
    targets = targets.concat(
      Game.rooms[r].find(FIND_HOSTILE_POWER_CREEPS).filter(target => target.owner.username === "Invader")
    );
  }
  const core = targets[Math.floor(Math.random() * targets.length)];
  if (core) core.pos.createFlag("attack", COLOR_CYAN, COLOR_BROWN);
}

function updateFlagReserve() {
  const flagReserve = Game.flags.reserve;
  if (flagReserve) {
    if (flagReserve.room && !shouldReserveRoom(flagReserve.room)) {
      flagReserve.remove();
    } else {
      return; // current flag is still valid
    }
  }
  const targets = getControllersToReserve();
  if (targets.length && targets[0]) targets[0].pos.createFlag("reserve", COLOR_ORANGE, COLOR_WHITE);
}

function needWorkers(room: Room) {
  for (const i in Game.rooms) {
    if (
      Game.rooms[i]
        .find(FIND_MY_STRUCTURES)
        .filter(structure => structure.structureType === STRUCTURE_STORAGE && getEnergy(structure) < 40000)
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
        .filter(structure => structure.structureType === STRUCTURE_STORAGE && getEnergy(structure) < 100000)
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
    spawnMsg(spawn, roleToSpawn, name, body, harvestPos);
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
  harvestPos: RoomPosition | undefined
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
      " " +
      (harvestPos ? "for " + harvestPos.toString() : "")
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
    role,
    sourceId,
    empty: true,
    full: false,
    timeApproachedDestination: Game.time,
    timeOfLastEnergyReceived: Game.time,
    lastOkActionTime: Game.time,
    x: pos.x,
    y: pos.y,
    roomName: pos.roomName,
    lastMoveTime: Game.time,
    destinationSetTime: Game.time,
    destination,
    lastDestination: undefined,
    action: task?.action,
    lastAction: undefined,
    lastActionOutcome: OK,
    lastBlockedIds: [],
    awaitingDeliveryFrom: undefined, // Creep name
    posRevisits: 0
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
    if (roleToSpawn === "worker") body = getBodyForWorker(energyAvailable);
    else if (roleToSpawn === "carrier") body = getBodyForCarrier(energyAvailable);
    else if (roleToSpawn === "reserver") body = getBodyForReserver(energyAvailable);
    else if (roleToSpawn === "attacker") body = getBodyForAttacker(energyAvailable);
  }
  const energyStructures = getSpawnsAndExtensionsSorted(spawn.room);
  const name = getNameForCreep(roleToSpawn);

  if (!body || getBodyCost(body) > spawn.room.energyAvailable) return;

  const outcome = spawn.spawnCreep(body, name, {
    memory: getInitialCreepMemory(roleToSpawn, undefined, spawn.pos, task),
    energyStructures
  });

  if (outcome === OK) {
    spawnMsg(spawn, roleToSpawn, name, body, undefined);
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
  if (targetCount > getStructureCount(room, structureType, true)) {
    if (structureType === STRUCTURE_ROAD) {
      return room.find(FIND_CONSTRUCTION_SITES).length < 3;
    } else {
      return true;
    }
  }
  return false;
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
  // save last values
  creep.memory.lastDestination = creep.memory.destination;
  creep.memory.lastAction = creep.memory.action;
  // reset properties
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
  return;
}

function isEmpty(object: Structure | Creep) {
  if (!object) return false;
  const store = getStore(object);
  if (!store) return false;
  return store.getUsedCapacity(RESOURCE_ENERGY) <= 0;
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
