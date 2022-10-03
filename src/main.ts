// When compiling TS to JS and bundling with rollup, the line numbers and file names in error messages change
// This utility uses source maps to get the line numbers and file names of the original, TS source code
import { ErrorMapper } from "utils/ErrorMapper";
import { Md5 } from "ts-md5";

declare global {
  type Role = "attacker" | "carrier" | "explorer" | "harvester" | "reserver" | "spawner" | "worker";
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

  interface Memory {
    username: string;
    harvestersNeeded: boolean;
    time: Record<number, TimeMemory>;
  }

  interface FlagMemory {
    steps: number;
    initTime: number;
  }

  interface TimeMemory {
    totalEnergyToHaul: number;
  }

  interface RoomMemory {
    upgradeSpots: RoomPosition[];
    harvestSpots: RoomPosition[];
    energyAvailable: number;
    hostilesPresent: boolean;
    constructionSiteCount: number;
    structureCount: number;
    status: "normal" | "closed" | "novice" | "respawn";
    canHarvest: boolean;
    timeOfLastSpawnEnergyDelivery: number;
    sortedSpawnStructureIds: Id<Structure>[];
    constructionSiteScore: number[][];
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
}

const minRoadTraffic = 0.011;

// Type guards
function isOwnedStructure(structure: Structure): structure is AnyOwnedStructure {
  return (structure as { my?: boolean }).my !== undefined;
}
function isLink(structure: Structure): structure is StructureLink {
  return structure.structureType === STRUCTURE_LINK;
}
function isInvaderCore(structure: Structure): structure is StructureInvaderCore {
  return structure.structureType === STRUCTURE_INVADER_CORE;
}
function isSpawnOrExtension(
  structure: Structure | null | undefined
): structure is StructureSpawn | StructureExtension {
  if (!structure) return false;
  return structure.structureType === STRUCTURE_SPAWN || structure.structureType === STRUCTURE_EXTENSION;
}
function isRoomPosition(item: RoomPosition): item is RoomPosition {
  return item instanceof RoomPosition;
}

// Main loop
export const loop = ErrorMapper.wrapLoop(() => {
  // Object.keys(Memory).map(key => key+': '+Object.keys(Memory[key]).length)
  const memLimit = 500;
  if (Object.keys(Memory.time).length > memLimit) purgeTimeMemory();
  if (Object.keys(Memory.flags).length > memLimit) purgeFlagsMemory();
  if (Object.keys(Game.flags).length > memLimit) purgeFlags();
  if (!Memory.username) {
    setUsername();
  }
  for (const c in Game.creeps) {
    const role = Game.creeps[c].memory.role;
    if (role === "harvester") handleHarvester(Game.creeps[c]);
    else if (role === "attacker") handleAttacker(Game.creeps[c]);
    else handleCreep(Game.creeps[c]);
  }
  for (const s in Game.spawns) handleSpawn(Game.spawns[s]);
  for (const r in Game.rooms) handleRoom(Game.rooms[r]);
  if (!Memory.time) Memory.time = {};
  if (!(Game.time in Memory.time)) Memory.time[Game.time] = { totalEnergyToHaul: totalEnergyToHaul() };
});

function purgeFlagsMemory() {
  for (const key in Memory.flags) {
    if (!Game.flags[key]) delete Memory.flags[key];
  }
}

function purgeFlags() {
  for (const flag of Object.values(Game.flags)) {
    if (flag.name.startsWith("traffic_") && Math.random() < 0.5) flag.remove();
  }
}

function trafficFlagName(pos: RoomPosition) {
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
      if (creep.room === flag.room) flag.remove(); // no targets to engage in this room
    } else {
      const target = getInvaderCore(creep.pos);
      if (target && "pos" in target) {
        target.pos.createFlag("attack", COLOR_CYAN, COLOR_BROWN);
        move(creep, target);
      } else {
        recycleCreep(creep); // still nothing to do
      }
    }
  }
}

function purgeTimeMemory() {
  let remove = true;
  for (const time in Memory.time) {
    if (remove) delete Memory.time[time];
    remove = !remove;
  }
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

function getReservableControllers() {
  const controllers = [];
  for (const r in Game.rooms) {
    const controller = Game.rooms[r].controller;
    if (!controller) continue;
    if (controller.owner) continue;
    if (reservationOk(controller)) continue;
    if (reservedByOthers(controller)) continue;
    controllers.push(controller);
  }
  return controllers
    .map(value => ({ value, sort: value.reservation?.ticksToEnd || 0 }))
    .sort((a, b) => a.sort - b.sort)
    .map(({ value }) => value);
}

function reservationOk(controller: StructureController) {
  const reservation = controller.reservation;
  if (!reservation) return false;
  if (reservation.username !== Memory.username) return false;
  if (reservation.ticksToEnd < 2500) return false;
  return true;
}

function reservedByOthers(controller: StructureController) {
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

  if (!destination) {
    destination = getClosest(creep.pos, Object.values(Game.spawns));
    if (destination) {
      setDestination(creep, destination);
    }
  }

  if (destination) {
    if (creep.pos.getRangeTo(destination) <= 1 && destination instanceof StructureSpawn) {
      destination.recycleCreep(creep);
    } else {
      move(creep, destination);
    }
  }
}

function handleHarvester(creep: Creep) {
  if (creep.memory.role !== "harvester") return false;
  if (creep.spawning) return true;
  if (creep.memory.action === "recycleCreep") {
    recycleCreep(creep);
    return true;
  }
  // move
  if (creep.name in Game.flags) {
    const flag = Game.flags[creep.name];
    move(creep, flag);
  }
  if (!isEmpty(creep)) {
    repair(creep);
    // build
    const site = creep.pos.findClosestByPath(creep.pos.findInRange(FIND_MY_CONSTRUCTION_SITES, 3));
    if (site) creep.build(site);
    // upgrade controller
    if (creep.room.controller) creep.upgradeController(creep.room.controller);
    // transfer
    if (isFull(creep)) unloadCreep(creep);
  }
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
  return true;
}

function repair(creep: Creep) {
  // repair my structures
  const myTarget = creep.pos.findClosestByPath(
    creep.pos
      .findInRange(FIND_MY_STRUCTURES, 3)
      .filter(myStructure => myStructure.my !== false && myStructure.hits < myStructure.hitsMax)
  );
  if (myTarget) creep.repair(myTarget);
  // repair unowned structures
  const target = creep.pos.findClosestByPath(
    creep.pos
      .findInRange(FIND_STRUCTURES, 3)
      .filter(structure => !isOwnedStructure(structure) && structure.hits < structure.hitsMax)
  );
  if (target) creep.repair(target);
}

function unloadCreep(creep: Creep) {
  const pos = creep.pos;
  const destination = pos.findClosestByPath(
    // link
    pos.findInRange(FIND_MY_STRUCTURES, 1).filter(target => !isFull(target) && isLink(target))
  );
  if (destination) {
    creep.transfer(destination, RESOURCE_ENERGY);
    return;
  }
  const targetCreep = pos.findClosestByPath(
    // carrier
    pos.findInRange(FIND_CREEPS, 1).filter(wantsEnergy)
  );
  if (targetCreep) {
    creep.transfer(targetCreep, RESOURCE_ENERGY);
    return;
  }
  const myStructure = pos.findClosestByPath(
    // my structure
    pos.findInRange(FIND_MY_STRUCTURES, 1).filter(target => !isFull(target) && target.my !== false)
  );
  if (myStructure) {
    creep.transfer(myStructure, RESOURCE_ENERGY);
    return;
  }
  const structure = pos.findClosestByPath(
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

function bodyByRatio(ratios: Partial<Record<BodyPartConstant, number>>, maxCost: number) {
  const partAmounts: Partial<Record<BodyPartConstant, number>> = {};
  let cost = 0;
  let partCount = 0;

  Object.keys(ratios).forEach(part => {
    partAmounts[part as BodyPartConstant] = 1;
    cost += BODYPART_COST[part as BodyPartConstant];
    partCount++;
  });

  for (;;) {
    // until break
    const nextPart = bodyPartToAddByRatio(ratios, partAmounts);

    if (cost + BODYPART_COST[nextPart] > maxCost) break;
    partAmounts[nextPart] = (partAmounts[nextPart] || 0) + 1;
    cost += BODYPART_COST[nextPart];
    partCount++;
    if (partCount >= 50) break;
  }

  const body: BodyPartConstant[] = [];
  //  for (const part in partAmounts) {
  Object.entries(partAmounts).forEach(([part, amount]) => {
    for (let x = 1; x <= (amount || 0); x++) {
      body.push(part as BodyPartConstant);
    }
  });

  return body;
}

function bodyPartToAddByRatio(
  ratios: Partial<Record<BodyPartConstant, number>>,
  partAmounts: Partial<Record<BodyPartConstant, number>>
) {
  let nextPart: BodyPartConstant = MOVE;
  let minRatio = Number.POSITIVE_INFINITY;

  Object.entries(ratios).forEach(([part, partRatio]) => {
    const amount = partAmounts[part as BodyPartConstant];
    if (amount && partRatio) {
      const ratio = amount / partRatio;
      if (minRatio > ratio) {
        minRatio = ratio;
        nextPart = part as BodyPartConstant;
      }
    }
  });

  return nextPart;
}

function handleRoom(room: Room) {
  // control the towers
  const towers = room
    .find(FIND_MY_STRUCTURES)
    .filter(tower => tower.structureType === STRUCTURE_TOWER) as StructureTower[];
  for (const t of towers) {
    const bestTarget = getTarget(t);
    if (bestTarget) engageTarget(t, bestTarget);
  }

  handleHostilesInRoom(room);

  if (canOperateInRoom(room)) {
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

  // handle the links
  handleLinks(room);

  if (!room.memory.upgradeSpots) updateUpgradeSpots(room);
  if (!room.memory.harvestSpots) updateHarvestSpots(room);

  // check the room details
  checkRoomStatus(room);
  checkRoomCanHarvest(room);
  checkRoomEnergy(room);
}

function checkRoomStatus(room: Room) {
  const value = roomStatus(room.name);
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

function linkDownstreamPos(room: Room) {
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
  const downstreamPos = linkDownstreamPos(room);
  if (!downstreamPos) return;

  const links = room
    .find(FIND_MY_STRUCTURES)
    .filter(isLink)
    .sort(function (x, y) {
      // sort: furthest/upstream -> closest/downstream
      return y.pos.getRangeTo(downstreamPos) - x.pos.getRangeTo(downstreamPos);
    });

  let upstreamIndex = 0;
  let downstreamIndex = links.length - 1;
  while (upstreamIndex < downstreamIndex) {
    const upstreamLink = links[upstreamIndex];
    const downstreamLink = links[downstreamIndex];

    if (isEmpty(upstreamLink) || upstreamLink.cooldown) {
      upstreamIndex++;
    } else if (fillRatio(downstreamLink) >= 0.9) {
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
    const score = targetScore(myUnit.pos, targetCreep);
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
    const score = targetScore(myUnit.pos, targetPowerCreep);
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
        ((!isEnemy(target) && canRepair(myUnit) && target.hits < target.hitsMax / 2) ||
          (isEnemy(target) && canAttack(myUnit)))
    );
  for (const targetStructure of structures) {
    const score = targetScore(myUnit.pos, targetStructure);
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
  return targets.sort((a, b) => b?.score - a?.score)[0].target;
}

function targetScore(pos: RoomPosition, target: Structure | Creep | PowerCreep) {
  let score = -pos.getRangeTo(target);
  if ("my" in target) {
    if (target.my === false) score += 10;
    if (target.my === true) score -= 10;
  }
  if (target instanceof Creep) score += target.getActiveBodyparts(HEAL);
  return score;
}

function getDestinationFromMemory(creep: Creep) {
  const oldDestination = creep.memory.destination;
  let destination: Destination | undefined;

  if ((!creep.memory.empty && isEmpty(creep)) || (!creep.memory.full && isFull(creep))) {
    return resetDestination(creep); // abandon the old plan after getting full/empty
  } else if (oldDestination) {
    if (typeof oldDestination === "string") {
      const object = Game.getObjectById(oldDestination);
      if (object) destination = object;
    } else if ("x" in oldDestination && "y" in oldDestination && "roomName" in oldDestination) {
      if (posEquals(creep.pos, oldDestination)) {
        creep.say("🛬");
        return resetDestination(creep); // abandon the old plan after reaching the target position
      } else {
        destination = new RoomPosition(oldDestination.x, oldDestination.y, oldDestination.roomName); // keep going
      }
    }

    if (destination && finishedRepair(creep, destination)) {
      return resetDestination(creep); // abandon the old plan after repair target doesn't need any more repair
    }

    if (
      destination &&
      creep.pos.roomName !== creep.memory.roomName &&
      creep.pos.roomName === destinationRoom(destination)
    ) {
      /*  we've just arrived to the destination room, let's reconsider the destination,
          now that we can calculate the distances within the room */
      return resetDestination(creep);
    }
  }
  return destination;
}

function finishedRepair(creep: Creep, destination: Destination) {
  return (
    creep.memory.action === "repair" &&
    destination &&
    "hits" in destination &&
    destination instanceof Structure &&
    !needsRepair(destination)
  );
}

function destinationRoom(destination: Destination) {
  if ("roomName" in destination) return destination.roomName;
  if ("pos" in destination) return destination.pos.roomName;
  return;
}

function atEdge(pos: RoomPosition) {
  if (pos.x < 1 || pos.y < 1 || pos.x > 48 || pos.y > 48) return true;
  return false;
}

function memorizeCreepState(creep: Creep) {
  if ((creep.memory.x || -1) !== creep.pos.x || (creep.memory.y || -1) !== creep.pos.y) {
    creep.memory.x = creep.pos.x;
    creep.memory.y = creep.pos.y;
    creep.memory.roomName = creep.pos.roomName;
    creep.memory.lastMoveTime = Game.time;
  }
  creep.memory.empty = isEmpty(creep);
  creep.memory.full = isFull(creep);
  updateConstructionSiteScoreForCreep(creep);
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
}

function getNewDestination(creep: Creep) {
  if (creep.spawning) return;
  const role = creep.memory.role;
  let task: Task | undefined;

  if (role === "worker") {
    task = getTaskForWorker(creep);
  } else if (role === "carrier") {
    task = getTaskForCarrier(creep);
  } else if (role === "spawner") {
    task = getTaskForSpawner(creep);
  } else if (role === "reserver") {
    const destination = getReservableControllers()[0];
    if (destination) task = { action: "reserveController", destination };
  } else if (role === "explorer") {
    const destination = getExit(creep.pos, !creep.ticksToLive || creep.ticksToLive > 150, false);
    if (destination) task = { action: "moveTo", destination };
  }

  if (task) {
    creep.memory.action = task.action;
    return task.destination;
  }

  return;
}

function getTaskForSpawner(creep: Creep) {
  let tasks: Task[] = [];
  if (!isFull(creep)) {
    const task = getEnergySourceTask(minTransferAmount(creep), creep.pos, true, true, false);
    if (task) tasks.push(task);
  }
  if (!isEmpty(creep)) {
    tasks = tasks.concat(
      getGlobalEnergyStructures(creep).map(d => {
        return { action: "transfer", destination: d };
      })
    );
  }
  return closestTask(creep.pos, tasks);
}

function closestTask(pos: RoomPosition, tasks: Task[]) {
  let closest;
  let minRange = Number.POSITIVE_INFINITY;

  tasks.forEach(task => {
    // this only works inside a single room
    const range = pos.getRangeTo(task.destination);
    if (minRange > range) {
      minRange = range;
      closest = task;
    }
  });

  /* we don't have ranges between rooms */
  return closest || tasks[Math.floor(Math.random() * tasks.length)];
}

function getTaskForCarrier(creep: Creep) {
  let tasks: Task[] = [];
  if (!isFull(creep)) {
    const task = getEnergySourceTask(minTransferAmount(creep), creep.pos, false, false, false);
    if (task) tasks.push(task);
  }
  if (!isEmpty(creep)) {
    tasks = tasks.concat(
      getEnergyDestinations().map(d => {
        return { action: "transfer", destination: d };
      })
    );
  }
  return closestTask(creep.pos, tasks);
}

function getClosest(pos: RoomPosition, options: Destination[]) {
  if (options.length < 1) return;
  let destination = pos.findClosestByPath(options); // same room
  if (destination) return destination;
  destination = options[Math.floor(Math.random() * options.length)]; // another room
  return destination;
}

function getEnergyDestinations() {
  let targets: Structure[] = [];

  for (const i in Game.rooms) {
    const room = Game.rooms[i];
    let roomTargets = room
      .find(FIND_MY_STRUCTURES)
      .filter(structure => structure.structureType === STRUCTURE_TOWER && !isFull(structure));
    if (roomTargets.length < 1) {
      roomTargets = room
        .find(FIND_MY_STRUCTURES)
        .filter(
          structure =>
            !isFull(structure) &&
            (isLink(structure) || structure.structureType === STRUCTURE_STORAGE) &&
            !isDownstreamLink(structure)
        );
    }
    if (roomTargets.length < 1) {
      roomTargets = getEnergyStructures(room);
    }
    targets = targets.concat(roomTargets);
  }

  return targets;
}

function getEnergySourceTask(
  myMinTransfer: number,
  pos: RoomPosition,
  allowStorage = true,
  allowAnyLink = true,
  allowSource = true
) {
  let sources: Destination[] = [];

  for (const i in Game.rooms) {
    sources = sources.concat(
      getEnergyInRoom(Game.rooms[i], myMinTransfer, pos, allowStorage, allowAnyLink, allowSource)
    );
  }

  const destination = getClosest(pos, sources);
  if (!destination) return;

  let action: Action = "withdraw";
  if (destination instanceof Source) {
    action = "harvest";
  } else if (destination instanceof Resource) {
    action = "pickup";
  } else if (destination instanceof RoomPosition) {
    action = "moveTo";
  }

  return { action, destination };
}

function getEnergyInRoom(
  room: Room,
  myMinTransfer: number,
  pos: RoomPosition,
  allowStorage = true,
  allowAnyLink = true,
  allowSource = true
) {
  let sources: Destination[] = room
    .find(FIND_DROPPED_RESOURCES)
    .filter(resource => getEnergy(resource) >= myMinTransfer);
  sources = sources.concat(room.find(FIND_TOMBSTONES).filter(tomb => getEnergy(tomb) >= myMinTransfer));
  sources = sources.concat(room.find(FIND_RUINS).filter(ruin => getEnergy(ruin) >= myMinTransfer));
  sources = sources.concat(
    room
      .find(FIND_STRUCTURES)
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

function nonWorkerTakeAction(creep: Creep, destination: Destination) {
  let actionOutcome;
  if (!destination) return;

  if (
    creep.memory.action === "withdraw" &&
    (destination instanceof Structure || destination instanceof Tombstone || destination instanceof Ruin)
  ) {
    actionOutcome = withdraw(creep, destination);
  } else if (
    creep.memory.action === "transfer" &&
    (destination instanceof Creep || destination instanceof Structure)
  ) {
    actionOutcome = transfer(creep, destination);
  } else if (creep.memory.action === "pickup" && destination instanceof Resource) {
    actionOutcome = pickup(creep, destination);
  } else if (creep.memory.action === "moveTo") {
    move(creep, destination);
  } else if (creep.memory.action === "reserveController" && destination instanceof StructureController) {
    actionOutcome = creep.reserveController(destination);
  } else if (creep.memory.action === "recycleCreep" && destination instanceof StructureSpawn) {
    actionOutcome = destination.recycleCreep(creep);
  } else if (creep.memory.action) {
    msg(creep, "can't handle action: " + creep.memory.action, true);
  } else if (destination) {
    msg(creep, "doesn't have action for destination: " + destination.toString(), true);
  }

  return actionOutcome;
}

function workerTakeAction(creep: Creep, destination: Destination) {
  let actionOutcome;
  if (!destination) return;

  if (creep.memory.action === "repair" && destination instanceof Structure) {
    actionOutcome = creep.repair(destination);
  } else if (
    creep.memory.action === "withdraw" &&
    (destination instanceof Structure || destination instanceof Tombstone || destination instanceof Ruin)
  ) {
    actionOutcome = withdraw(creep, destination);
  } else if (
    creep.memory.action === "transfer" &&
    (destination instanceof Creep || destination instanceof Structure)
  ) {
    actionOutcome = transfer(creep, destination);
  } else if (creep.memory.action === "upgradeController" && destination instanceof StructureController) {
    actionOutcome = creep.upgradeController(destination);
  } else if (creep.memory.action === "pickup" && destination instanceof Resource) {
    actionOutcome = pickup(creep, destination);
  } else if (creep.memory.action === "harvest" && destination instanceof Source) {
    actionOutcome = creep.harvest(destination);
  } else if (creep.memory.action === "moveTo") {
    move(creep, destination);
  } else if (creep.memory.action === "build" && destination instanceof ConstructionSite) {
    actionOutcome = creep.build(destination);
  } else if (creep.memory.action === "recycleCreep" && destination instanceof StructureSpawn) {
    actionOutcome = destination.recycleCreep(creep);
  } else if (creep.memory.action) {
    msg(creep, "can't handle action: " + creep.memory.action, true);
  } else if (destination) {
    msg(creep, "doesn't have action for destination: " + destination.toString(), true);
  }

  return actionOutcome;
}

function move(creep: Creep, destination: Destination) {
  const flagName = trafficFlagName(creep.pos);
  const flag = Game.flags[flagName];
  if (flag) {
    if ("steps" in flag.memory) {
      flag.memory.steps++;
    } else {
      flag.memory.steps = 0;
      flag.memory.initTime = Game.time;
    }
  } else {
    creep.pos.createFlag(flagName, COLOR_GREEN, COLOR_GREY);
  }
  return creep.moveTo(destination, {
    visualizePathStyle: { stroke: hashColor(creep.memory.role) }
  });
}

function withdraw(creep: Creep, destination: Destination) {
  if (destination instanceof Structure || destination instanceof Tombstone || destination instanceof Ruin) {
    const actionOutcome = creep.withdraw(destination, RESOURCE_ENERGY);
    if (actionOutcome === OK) resetSpecificDestinationFromCreeps(destination);
    return actionOutcome;
  }
  return;
}

function pickup(creep: Creep, destination: Destination) {
  if (destination instanceof Resource) {
    const actionOutcome = creep.pickup(destination);
    if (actionOutcome === OK) resetSpecificDestinationFromCreeps(destination);
    return actionOutcome;
  }
  return;
}

function resetSpecificDestinationFromCreeps(destination: Destination) {
  for (const i in Game.creeps) {
    const creep = Game.creeps[i];
    if (creep.memory.destination && "id" in destination && creep.memory.destination === destination.id) {
      resetDestination(creep);
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

function postAction(creep: Creep, destination: Destination, actionOutcome: ScreepsReturnCode) {
  if (actionOutcome === OK) {
    creep.memory.lastOkActionTime = Game.time;
  } else if (destination) {
    if (actionOutcome === ERR_NOT_IN_RANGE && (destination instanceof RoomPosition || "pos" in destination)) {
      move(creep, destination);
    } else if (actionOutcome === ERR_FULL) {
      resetDestination(creep);
      handleCreep(creep);
      return;
    } else if (actionOutcome === ERR_NOT_ENOUGH_RESOURCES) {
      resetDestination(creep);
      handleCreep(creep);
      return;
    } else if (actionOutcome === ERR_NO_PATH) {
      creep.say("🚧");
      resetDestination(creep);
      handleCreep(creep);
    } else if (actionOutcome === ERR_INVALID_TARGET) {
      creep.say("🔎");
      resetDestination(creep);
      if (destination instanceof Structure || destination instanceof RoomPosition)
        memorizeBlockedObject(creep, destination);
    } else if (actionOutcome === ERR_TIRED) {
      creep.say("😓");
    } else if (actionOutcome === ERR_NOT_OWNER) {
      handleNotOwner(creep);
    }
  }
}

function handleNotOwner(creep: Creep) {
  creep.say("👮");
  resetDestination(creep);
  const exit = getExit(creep.pos);
  if (exit) {
    creep.memory.destination = exit;
    creep.memory.destinationSetTime = Game.time;
  }
}

function needsRepair(structure: Structure) {
  if (!structure) return false;
  if (isOwnedStructure(structure) && structure.my === false) return false;
  if (!structure.hits) return false;
  if (!structure.hitsMax) return false;
  if (structure.hits >= structure.hitsMax) return false;
  if (structure instanceof StructureRoad && getTrafficRateAt(structure.pos) < minRoadTraffic) return false;
  return true;
}

function worthRepair(pos: RoomPosition, structure: Structure) {
  if (!needsRepair(structure)) return false;
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

function getRepairTaskInRange(pos: RoomPosition) {
  const destination = pos.findClosestByPath(
    pos
      .findInRange(FIND_MY_STRUCTURES, 3)
      .filter(target => target.my !== false && target.hits < target.hitsMax)
  );
  if (destination) {
    const task: Task = { action: "repair", destination };
    if (task) return task;
  }
  const unowned = pos.findClosestByPath(
    pos
      .findInRange(FIND_STRUCTURES, 3)
      .filter(target => !isOwnedStructure(target) && target.hits < target.hitsMax)
  );
  if (unowned) {
    const task: Task = { action: "repair", destination: unowned };
    if (task) return task;
  }
  return;
}

function getBuildTaskInRange(pos: RoomPosition) {
  const destination = pos.findClosestByPath(pos.findInRange(FIND_MY_CONSTRUCTION_SITES, 3));
  if (destination) {
    const action: Action = "build";
    const task: Task = { action, destination };
    return task;
  }
  return;
}

function getUpgradeTask(pos: RoomPosition, urgentOnly: boolean) {
  const targets = [];
  for (const i in Game.rooms) {
    const room = Game.rooms[i];
    if (!room.controller) continue;
    if (!room.controller.my) continue;
    if (urgentOnly && room.controller.ticksToDowngrade > 2000) continue;
    targets.push(room.controller);
  }
  const destination = getClosest(pos, targets);
  if (destination) {
    const task: Task = { action: "upgradeController", destination };
    return task;
  }
  return;
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
    if (flag.name in Game.creeps) return true;
  }
  return false;
}

function getRepairTask(creep: Creep) {
  let destinations: Destination[] = [];

  for (const i in Game.rooms) {
    const room = Game.rooms[i];
    destinations = destinations.concat(
      room
        .find(FIND_STRUCTURES)
        .filter(
          target => worthRepair(creep.pos, target) && !isUnderRepair(target) && !isBlocked(creep, target)
        )
    );
  }

  const destination = getClosest(creep.pos, destinations);
  if (!destination) return;

  return { action: "repair", destination } as Task;
}

function taskMoveRandomly(roomName: string) {
  const x = Math.floor(Math.random() * 10);
  const y = Math.floor(Math.random() * 10);
  const task: Task = { action: "moveTo", destination: new RoomPosition(x, y, roomName) };
  return task;
}

function workerSpendEnergyTask(creep: Creep) {
  // upgrade the room controller if it's about to downgrade
  let task: Task | undefined = getUpgradeTask(creep.pos, true);
  // repair structures
  if (!task) task = getRepairTask(creep);
  // build structures
  if (!task) {
    const destination = getClosest(creep.pos, getConstructionSites(creep));
    if (destination) task = { action: "build", destination };
  }
  // upgrade the room controller
  if (!task) task = getUpgradeTask(creep.pos, false);
  // return the final destination
  if (task) {
    let pos;
    if (task.destination instanceof RoomPosition) pos = task.destination;
    else if (task.destination.pos instanceof RoomPosition) pos = task.destination.pos;

    if (pos) {
      const flagName = pos.roomName + "_EnergyConsumer";
      const color1 = COLOR_BLUE;
      const color2 = COLOR_PURPLE;
      if (flagName in Game.flags) {
        const flag = Game.flags[flagName];
        flag.setPosition(pos); /* handles the first setColor or setPosition per tick! */
      } else {
        pos.createFlag(flagName, color1, color2);
      }
    }
    return task;
  }
  return;
}

function getConstructionSites(creep: Creep) {
  let sites: ConstructionSite[] = [];
  for (const i in Game.rooms) {
    const room = Game.rooms[i];
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

function useLink(creep: Creep) {
  if (countStructures(creep.room, STRUCTURE_LINK, false) < 2) return false;
  if (!isLinkNear(creep.pos)) return false;
  return true;
}

function hashColor(seed: string) {
  const hash = Md5.hashStr(seed);
  let offset = 0;
  let hex;
  let hsl;
  do {
    hex = hash.substring(0 + offset, 6 + offset);
    hsl = hexToHSL(hex);
    offset++;
  } while (!hsl || hsl.l < 0.6);
  // msg('hashColor',seed+' > '+hex+' > H:'+hsl['h']+', S:'+hsl['s']+', l:'+hsl['l']+' offset:'+offset);
  return "#" + hex;
}

function isBlocked(creep: Creep, target: ConstructionSite | Structure) {
  if (!creep.memory.lastBlockedIds) return false;
  if (creep.memory.lastBlockedIds.includes(target.id)) return true;
  return false;
}

function memorizeBlockedObject(creep: Creep, destination: Destination) {
  if (!creep.memory.lastBlockedIds) creep.memory.lastBlockedIds = [];
  if (destination && "id" in destination) {
    creep.memory.lastBlockedIds.push(destination.id);
    if (creep.memory.lastBlockedIds.length > 1) creep.memory.lastBlockedIds.shift();
  }
}

function isLinkNear(pos: RoomPosition) {
  const maxRange = 6;
  return pos.findInRange(FIND_MY_STRUCTURES, maxRange).filter(isLink).length > 0;
}

function orderEnergy(creep: Creep) {
  // order energy from closest available carrier
  if (
    creep.memory.role === "worker" &&
    !creep.memory.awaitingDeliveryFrom &&
    (creep.memory.timeOfLastEnergyReceived || 0) < Game.time &&
    creep.store.getFreeCapacity(RESOURCE_ENERGY) >= minTransferAmount(creep)
  ) {
    const carriers = Object.values(Game.creeps).filter(function (carrierCreep) {
      return (
        carrierCreep.memory.role === "carrier" && !isEmpty(carrierCreep) && !hasImportantTask(carrierCreep)
      );
    });
    const carrier = creep.pos.findClosestByPath(carriers);
    if (carrier) {
      carrier.memory.action = "transfer";
      carrier.memory.destination = creep.id; // deliver to me
      carrier.memory.destinationSetTime = Game.time;
      creep.memory.awaitingDeliveryFrom = carrier.name; // my carrier
      creep.say(carrier.name);
    }
  }
}

function minTransferAmount(creep: Creep) {
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

function getGlobalEnergyStructures(creep: Creep) {
  let structures: AnyOwnedStructure[] = [];
  for (const i in Game.rooms) {
    const room = Game.rooms[i];
    structures = structures.concat(
      room
        .find(FIND_MY_STRUCTURES)
        .filter(
          structure =>
            (structure.structureType === STRUCTURE_EXTENSION ||
              structure.structureType === STRUCTURE_SPAWN) &&
            !isFull(structure) &&
            !isBlocked(creep, structure)
        )
    );
  }
  return structures;
}

function canOperateInRoom(room: Room) {
  if (!room.controller) return true; // no controller
  if (room.controller.my) return true; // my controller
  const reservation = room.controller.reservation;
  if (reservation && reservation.username === Memory.username) return true; // reserved to me
  if (!room.controller.owner && !reservation) return true; // no owner & no reservation
  return false;
}

function roomStatus(roomName: string) {
  return Game.map.getRoomStatus(roomName).status;
}

function isRoomSafe(roomName: string, currentRoomName: string) {
  if (roomStatus(currentRoomName) === "novice" && roomStatus(roomName) !== "novice") return false;
  if (roomStatus(roomName) === "closed") return false;
  if (!Memory.rooms[roomName]) return true;
  if (Memory.rooms[roomName].hostilesPresent) return false;
  return true;
}

function getExit(pos: RoomPosition, safeOnly = true, harvestableOnly = true) {
  if (!pos) return;
  const exits = Game.map.describeExits(pos.roomName);
  const accessibleRooms = Object.values(exits).filter(
    roomName =>
      (!safeOnly || isRoomSafe(roomName, pos.roomName)) &&
      (!harvestableOnly || Memory.rooms[roomName].canHarvest)
  );
  const destinationRoomName = accessibleRooms[Math.floor(Math.random() * accessibleRooms.length)];
  const findExit = Game.map.findExit(pos.roomName, destinationRoomName);
  if (findExit === ERR_NO_PATH) {
    msg(pos, "getExit(): no path between rooms: " + pos.roomName + " - " + destinationRoomName);
  } else if (findExit === ERR_INVALID_ARGS) {
    msg(pos, "getExit() passed invalid arguments to Game.map.findExit()");
  } else {
    const exit = pos.findClosestByPath(findExit);
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
      let score = countWorkSpotsAround(pos, true);
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
          let score = countWorkSpotsAround(pos, target instanceof StructureController);
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
      .map(value => ({ value, sort: Math.random() }))
      .sort((a, b) => a.sort - b.sort)
      .map(({ value }) => value)
  );
  return placesRequiringLink;
}

function countWorkSpotsAround(pos: RoomPosition, upgrade: boolean) {
  const spots = upgrade ? Memory.rooms[pos.roomName].upgradeSpots : Memory.rooms[pos.roomName].harvestSpots;
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

function hasStructureAt(
  pos: RoomPosition,
  structureType: StructureConstant | undefined,
  includeConstructionSites: boolean
) {
  if (
    pos
      .lookFor(LOOK_STRUCTURES)
      .filter(structure => !structureType || structure.structureType === structureType).length > 0
  )
    return true;

  if (
    includeConstructionSites &&
    pos
      .lookFor(LOOK_CONSTRUCTION_SITES)
      .filter(structure => !structureType || structure.structureType === structureType).length > 0
  )
    return true;

  return false;
}

function getPosForContainer(room: Room) {
  const harvestSpots = room.memory.harvestSpots;

  if (!harvestSpots) return;

  const spots = harvestSpots
    .map(value => ({ value, sort: Math.random() }))
    .sort((a, b) => a.sort - b.sort)
    .map(({ value }) => value);

  for (const spot of spots) {
    const pos = new RoomPosition(spot.x, spot.y, spot.roomName);
    if (pos.lookFor(LOOK_STRUCTURES).length) continue;
    if (pos.lookFor(LOOK_CONSTRUCTION_SITES).length) continue;
    return pos;
  }
  return;
}

function adjustConstructionSiteScoreForLink(score: number, pos: RoomPosition) {
  // distance to exit decreases the score
  const penalty = pos.findClosestByPath(FIND_EXIT);
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
  if (structureType === STRUCTURE_CONTAINER) return getPosForContainer(room);
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
    .filter(flag => flag.name.startsWith("traffic_") && flag.memory && flag.memory.steps > 0);
  let bestScore = Number.NEGATIVE_INFINITY;
  let bestPos;
  for (const flag of flags) {
    if (isEdge(flag.pos)) continue;
    const score = getTrafficRate(flag);
    if (bestScore < score && score > minRoadTraffic && !hasStructureAt(flag.pos, STRUCTURE_ROAD, true)) {
      bestScore = score;
      bestPos = flag.pos;
    }
  }
  return bestPos;
}

function isEdge(pos: RoomPosition) {
  if (pos.x <= 0) return true;
  if (pos.y <= 0) return true;
  if (pos.x >= 49) return true;
  if (pos.y >= 49) return true;
  return false;
}

function getTrafficRate(flag: Flag) {
  if (!flag) return 0;
  if (!("initTime" in flag.memory)) return 0;
  if (flag.memory.initTime >= Game.time) return 0;
  return (flag.memory.steps || 0) / (Game.time - flag.memory.initTime);
}

function getTrafficRateAt(pos: RoomPosition) {
  return getTrafficRate(Game.flags[trafficFlagName(pos)]);
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

    if (getCreepCountByRole("spawner") < getCreepCountByRole("harvester") / 2) {
      roleToSpawn = "spawner";
    } else if (carriersNeeded()) {
      roleToSpawn = "carrier";
    } else if (harvestersNeeded(spawn.pos)) {
      spawnHarvester(spawn);
      return;
    } else if (getCreepCountByRole("reserver") < getReservableControllers().length) {
      roleToSpawn = "reserver";
      minBudget = 1300;
    } else if (getInvaderCore(spawn.pos)) {
      roleToSpawn = "attacker";
    } else if (getCreepCountByRole("explorer") <= 0) {
      roleToSpawn = "explorer";
      body = [MOVE];
    } else if (workersNeeded(spawn.room)) {
      roleToSpawn = "worker";
      minBudget = 300;
    } else {
      return;
    }

    const budget = getSpawnBudget(roleToSpawn, minBudget, spawn.room.energyCapacityAvailable);
    if (spawn.room.energyAvailable >= budget) {
      spawnCreep(spawn, roleToSpawn, budget, body);
    }
  }
}

function getInvaderCore(pos: RoomPosition) {
  let cores: StructureInvaderCore[] = [];
  for (const r in Game.rooms) {
    cores = cores.concat(Game.rooms[r].find(FIND_HOSTILE_STRUCTURES).filter(isInvaderCore));
  }
  return getClosest(pos, cores);
}

function workersNeeded(room: Room) {
  for (const i in Game.rooms) {
    if (
      Game.rooms[i]
        .find(FIND_MY_STRUCTURES)
        .filter(structure => structure.structureType === STRUCTURE_STORAGE && getEnergy(structure) < 5000)
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
      (aggregated, item) => aggregated + (item.memory.role === role ? creepCost(item) : 0),
      0 /* initial*/
    ) || 0
  );
}

function harvestersNeeded(pos: RoomPosition) {
  const source = getSourceToHarvest(pos);

  if (!source) return false; // nothing to harvest

  if (Memory.harvestersNeeded) return true;

  if (
    source.pos.findInRange(FIND_MY_STRUCTURES, 1).filter(target => target.structureType === STRUCTURE_LINK)
      .length > 0
  )
    return true; // always keep sources with link manned;

  for (const i in Game.rooms) {
    if (
      Game.rooms[i]
        .find(FIND_MY_STRUCTURES)
        .filter(structure => structure.structureType === STRUCTURE_STORAGE && getEnergy(structure) < 10000)
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
    if (!canOperateInRoom(room)) continue;
    sources = sources.concat(
      room.find(FIND_SOURCES).filter(harvestSource => !sourceHasHarvester(harvestSource))
    );
  }
  if (sources.length < 1) return;
  let source = pos.findClosestByPath(sources); // same room
  if (source) return source;
  source = sources[Math.floor(Math.random() * sources.length)]; // another room
  return source;
}

function spawnHarvester(spawn: StructureSpawn) {
  const roleToSpawn: Role = "harvester"; // no energy for workers
  const source = getSourceToHarvest(spawn.pos);
  if (!source || !(source instanceof Source)) return;
  const workParts = source.energyCapacity / ENERGY_REGEN_TIME / HARVEST_POWER;
  let body: BodyPartConstant[] = [CARRY, MOVE];
  const partsToAdd: BodyPartConstant[] = [WORK, MOVE];
  for (let x = 1; x <= workParts; x++) {
    const newBody: BodyPartConstant[] = body.concat(partsToAdd);
    if (bodyCost(newBody) > spawn.room.energyCapacityAvailable) break;
    body = newBody;
  }
  if (bodyCost(body) > spawn.room.energyAvailable && getCreepCountByRole(roleToSpawn) < 1) {
    body = body.filter((value, index, self) => self.indexOf(value) === index); // unique
  }
  const cost = bodyCost(body);
  if (cost > spawn.room.energyAvailable) return false;
  const energyStructures: (StructureSpawn | StructureExtension)[] = getSpawnsAndExtensionsSorted(spawn.room);
  const name = nameForCreep(roleToSpawn);
  const harvestPos = getHarvestSpotForSource(source);
  if (!harvestPos) return;
  constructContainerIfNeeded(harvestPos);
  const memory = initialCreepMemory(roleToSpawn, source.id, spawn.pos);
  if (spawn.spawnCreep(body, name, { memory, energyStructures }) === OK) {
    Memory.harvestersNeeded = false;
    setDestinationFlag(name, harvestPos);
    spawnMsg(spawn, roleToSpawn, name, body, harvestPos);
  }
  return true;
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
      bodyCost(body).toString() +
      "/" +
      spawn.room.energyAvailable.toString() +
      "/" +
      spawn.room.energyCapacityAvailable.toString() +
      " " +
      (harvestPos ? "for " + harvestPos.toString() : "")
  );
}

function setDestinationFlag(flagName: string, pos: RoomPosition) {
  const color1 = COLOR_ORANGE;
  const color2 = COLOR_GREEN;
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

function initialCreepMemory(role: Role, sourceId: undefined | Id<Source>, pos: RoomPosition) {
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
    destination: undefined,
    lastDestination: undefined,
    action: undefined,
    lastAction: undefined,
    lastActionOutcome: OK,
    lastBlockedIds: [],
    awaitingDeliveryFrom: undefined, // Creep name
    posRevisits: 0
  };
}

function constructContainerIfNeeded(harvestPos: RoomPosition) {
  if (
    harvestPos.lookFor(LOOK_STRUCTURES).length + harvestPos.lookFor(LOOK_CONSTRUCTION_SITES).length <= 0 &&
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

function creepCost(creep: Creep) {
  return bodyCost(creep.body.map(part => part.type));
}

function carriersNeeded() {
  return totalCreepCapacity("carrier") < totalEnergyToHaul();
}

function totalEnergyToHaul() {
  let energy = 0;
  for (const i in Game.rooms) {
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

function totalCreepCapacity(role: Role | undefined) {
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
  body: undefined | BodyPartConstant[]
) {
  if (!body) {
    if (roleToSpawn === "worker") body = bodyByRatio({ move: 3, work: 4, carry: 1 }, energyAvailable);
    else if (roleToSpawn === "carrier" || roleToSpawn === "spawner")
      body = bodyByRatio({ move: 1, carry: 1 }, energyAvailable);
    else if (roleToSpawn === "reserver") body = bodyByRatio({ move: 1, claim: 1 }, energyAvailable);
    else if (roleToSpawn === "attacker") body = bodyByRatio({ move: 1, attack: 2 }, energyAvailable);
  }
  const energyStructures = getSpawnsAndExtensionsSorted(spawn.room);
  const name = nameForCreep(roleToSpawn);

  if (!body || bodyCost(body) > spawn.room.energyAvailable) return;

  const outcome = spawn.spawnCreep(body, name, {
    memory: initialCreepMemory(roleToSpawn, undefined, spawn.pos),
    energyStructures
  });

  if (outcome === OK) {
    spawnMsg(spawn, roleToSpawn, name, body, undefined);
  } else {
    msg(spawn, "Failed to spawn creep: " + outcome.toString());
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

function nameForCreep(role: Role) {
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
    pos.lookFor(LOOK_STRUCTURES).forEach(structure => {
      if (structure instanceof StructureExtension) {
        msg(structure, "Destroying to make space for: " + structureType);
        structure.destroy();
      }
    });
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
    const roadFlags = pos.lookFor(LOOK_FLAGS).filter(flag => flag.name.endsWith("_RoadNeeded"));
    for (const flag of roadFlags) flag.remove();
    if (structureType === STRUCTURE_LINK) {
      pos
        .findInRange(FIND_STRUCTURES, 1)
        .filter(target => target.structureType === STRUCTURE_CONTAINER)
        .forEach(structure => {
          msg(structure, "Destroying around new " + structureType);
          structure.destroy();
        });
    }
  }
}

function needStructure(room: Room, structureType: BuildableStructureConstant) {
  if (!room.controller) return false; // no controller
  if (!room.controller.my && room.controller.owner) return false; // owned by others
  const targetCount = CONTROLLER_STRUCTURES[structureType][room.controller.level];
  if (targetCount > countStructures(room, structureType, true)) {
    if (structureType === STRUCTURE_ROAD) {
      return room.find(FIND_CONSTRUCTION_SITES).length < 1;
    } else {
      return true;
    }
  }
  return false;
}

function countStructures(room: Room, structureType: StructureConstant, includeConstructionSites: boolean) {
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

function bodyCost(body: BodyPartConstant[]) {
  return body.reduce(function (cost, part) {
    return cost + BODYPART_COST[part];
  }, 0);
}

function hasImportantTask(creep: Creep) {
  const destinationId = creep.memory.destination;
  if (!destinationId) return false;
  if (destinationId instanceof RoomPosition) return false;
  const destination = Game.getObjectById(destinationId);
  if (!destination) return false;
  return destination instanceof Creep;
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
function fillRatio(object: Structure | Creep) {
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

function handleCreep(creep: Creep) {
  if (creep.spawning) return;

  if (creep.memory.awaitingDeliveryFrom && !Game.creeps[creep.memory.awaitingDeliveryFrom]) {
    creep.memory.awaitingDeliveryFrom = undefined; // no longer await delivery from a dead creep
  }

  let destination = getDestinationFromMemory(creep);

  // create a new plan if situation requires
  if (!destination && (!creep.memory.awaitingDeliveryFrom || atEdge(creep.pos))) {
    destination = getNewDestination(creep);
    if (destination) {
      setDestination(creep, destination);
    } else {
      recycleCreep(creep);
    }
  }

  if (destination) {
    let actionOutcome;
    if (creep.memory.role === "worker") {
      actionOutcome = workerTakeAction(creep, destination);
    } else {
      actionOutcome = nonWorkerTakeAction(creep, destination);
    }
    if (actionOutcome !== undefined) {
      creep.memory.lastActionOutcome = actionOutcome;
      if (actionOutcome === OK) creep.memory.lastOkActionTime = Game.time;
      postAction(creep, destination, actionOutcome);
    }

    handleBlockedDestination(creep, destination);
  }
  memorizeCreepState(creep);
}

function handleBlockedDestination(creep: Creep, destination: Destination) {
  if (creep.memory.posRevisits > 0) {
    creep.say("⌛️");
    resetDestination(creep);
    memorizeBlockedObject(creep, destination);
  }
}

function getTaskForWorker(creep: Creep) {
  if (creep.memory.awaitingDeliveryFrom && atEdge(creep.pos)) return taskMoveRandomly(creep.pos.roomName);

  if (isFull(creep)) {
    // spend energy without moving
    const task: Task | undefined = getRepairTaskInRange(creep.pos) || getBuildTaskInRange(creep.pos);
    if (task) return task;
  }

  // order more energy
  if (!useLink(creep)) orderEnergy(creep);

  if (isEmpty(creep) && !creep.memory.awaitingDeliveryFrom) {
    // fetch nearby energy
    const allowSource = getCreepCountByRole("harvester") < 1;
    const task: Task | undefined = getEnergySourceTask(
      minTransferAmount(creep),
      creep.pos,
      true,
      true,
      allowSource
    );
    if (task) {
      return task;
    }
    return { action: "moveTo", destination: getExit(creep.pos) } as Task;
  } else if (!isEmpty(creep)) {
    // use energy
    return workerSpendEnergyTask(creep);
  }
  return;
}
