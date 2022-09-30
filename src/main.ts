// When compiling TS to JS and bundling with rollup, the line numbers and file names in error messages change
// This utility uses source maps to get the line numbers and file names of the original, TS source code
import { ErrorMapper } from "utils/ErrorMapper";
import { Md5 } from "ts-md5";

declare global {
  type Role = "carrier" | "explorer" | "harvester" | "reserver" | "spawner" | "worker";
  type Action =
    | "build"
    | "harvest"
    | "moveTo"
    | "pickup"
    | "repair"
    | "reserveController"
    | "transfer"
    | "upgradeController"
    | "withdraw";
  type Destination = ConstructionSite | Creep | RoomPosition | Source | Structure;
  type DestinationId = Id<Structure | ConstructionSite | Source | Creep>;

  interface Memory {
    username: string;
    harvestersNeeded: boolean;
    time: Record<number, TimeMemory>;
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
    lastEnergyConsumerPos: RoomPosition;
    timeOfLastSpawnEnergyDelivery: number;
    sortedSpawnStructureIds: Id<Structure>[];
    constructionSiteScore: number[][];
  }

  interface CreepMemory {
    role: Role;
    targetPos: undefined | RoomPosition;
    sourceId: undefined | Id<Source>;
    empty: boolean;
    full: boolean;
    timeApproachedDestination: number;
    timeOfLastEnergyReceived: number;
    lastOkActionTime: number;
    rangeToDestination: number;
    x: number;
    y: number;
    roomName: string;
    lastMoveTime: number;
    destinationSetTime: number;
    destination: undefined | Id<ConstructionSite | Creep | Source | Structure> | RoomPosition;
    lastDestination: undefined | Id<ConstructionSite | Creep | Source | Structure> | RoomPosition;
    action: undefined | Action;
    lastAction: undefined | Action;
    lastActionOutcome: ScreepsReturnCode;
    lastBlockedIds: DestinationId[];
    awaitingDeliveryFrom: undefined | string; //Creep name
  }

  interface Task {
    action: Action;
    destination: Destination;
  }

  // Syntax for adding proprties to `global` (ex "global.log")
  namespace NodeJS {
    interface Global {
      log: any;
    }
  }
}

//Type guards
function isOwnedStructure(structure: Structure): structure is AnyOwnedStructure {
  return (structure as { my?: boolean }).my != undefined;
}
function isLink(structure: Structure): structure is StructureLink {
  return structure.structureType === STRUCTURE_LINK;
}
function isSpawnOrExtension(
  structure: Structure | null | undefined
): structure is StructureSpawn | StructureExtension {
  if (!structure) return false;
  return structure.structureType === STRUCTURE_SPAWN || structure.structureType === STRUCTURE_EXTENSION;
}
function isRoomPosition(item: any): item is RoomPosition {
  return item instanceof RoomPosition;
}

//Main loop
export const loop = ErrorMapper.wrapLoop(() => {
  if (!Memory.username) setUsername();
  for (const c in Game.creeps) handleHarvester(Game.creeps[c]) || handleCreep(Game.creeps[c]);
  for (const s in Game.spawns) handleSpawn(Game.spawns[s]);
  for (const r in Game.rooms) handleRoom(Game.rooms[r]);

  if (!Memory.time) Memory.time = {};
  if (!(Game.time in Memory.time)) Memory.time[Game.time] = { totalEnergyToHaul: totalEnergyToHaul() };
});

const setUsername = function () {
  //room controllers
  for (const r in Game.rooms) {
    let room = Game.rooms[r];
    if (room.controller && room.controller.my && room.controller.owner) {
      Memory.username = room.controller.owner.username;
      return;
    }
  }
  //creeps
  const creeps = Object.values(Game.creeps);
  if (creeps.length) {
    Memory.username = creeps[0].owner.username;
    return;
  }
};

function getReservableControllers() {
  let controllers = [];
  for (const r in Game.rooms) {
    let controller = Game.rooms[r].controller;
    if (!controller) continue;
    if (controller.owner) continue;
    if (reservationOk(controller)) continue;
    controllers.push(controller);
  }
  return shuffle(controllers);
}

function reservationOk(controller: StructureController) {
  let reservation = controller.reservation;
  if (!reservation) return false;
  if (reservation.username !== Memory.username) return false;
  if (reservation.ticksToEnd < 2500) return false;
  return true;
}

function handleHarvester(creep: Creep) {
  if (creep.memory.role !== "harvester") return false;
  if (creep.spawning) return true;
  //move
  if (creep.memory.targetPos) {
    let destination = new RoomPosition(
      creep.memory.targetPos.x,
      creep.memory.targetPos.y,
      creep.memory.targetPos.roomName
    );
    let pathColor = hashColor(creep.memory.role);
    creep.moveTo(destination, { visualizePathStyle: { stroke: pathColor } });
  }
  if (!isEmpty(creep)) {
    //repair my structures
    let myTarget = creep.pos.findClosestByPath(
      creep.pos
        .findInRange(FIND_MY_STRUCTURES, 3)
        .filter(target => target.my !== false && target.hits < target.hitsMax)
    );
    if (myTarget) creep.repair(myTarget);
    //repair unowned structures
    let target = creep.pos.findClosestByPath(
      creep.pos
        .findInRange(FIND_STRUCTURES, 3)
        .filter(target => !isOwnedStructure(target) && target.hits < target.hitsMax)
    );
    if (target) creep.repair(target);
    //build
    let site = creep.pos.findClosestByPath(creep.pos.findInRange(FIND_MY_CONSTRUCTION_SITES, 3));
    if (site) creep.build(site);
    //upgrade controller
    if (creep.room.controller) creep.upgradeController(creep.room.controller);
    //transfer
    if (isFull(creep)) unloadCreep(creep);
  }
  //harvest
  let sourceId = creep.memory.sourceId;
  if (sourceId) {
    let source = Game.getObjectById(sourceId);
    if (source) creep.harvest(source);
  }
  //done
  return true;
}

function unloadCreep(creep: Creep) {
  let pos = creep.pos;
  let destination = pos.findClosestByPath(
    //link
    pos.findInRange(FIND_MY_STRUCTURES, 1).filter(target => !isFull(target) && isLink(target))
  );
  if (destination) {
    creep.transfer(destination, RESOURCE_ENERGY);
    return;
  }
  let targetCreep = pos.findClosestByPath(
    //carrier
    pos
      .findInRange(FIND_CREEPS, 1)
      .filter(
        target =>
          !isFull(target) &&
          target.my !== false &&
          (target.memory.role === "carrier" ||
            target.memory.role === "spawner" ||
            target.memory.role === "worker")
      )
  );
  if (targetCreep) {
    creep.transfer(targetCreep, RESOURCE_ENERGY);
    return;
  }
  let myStructure = pos.findClosestByPath(
    //my structure
    pos.findInRange(FIND_MY_STRUCTURES, 1).filter(target => !isFull(target) && target.my !== false)
  );
  if (myStructure) {
    creep.transfer(myStructure, RESOURCE_ENERGY);
    return;
  }
  let structure = pos.findClosestByPath(
    //unowned structure
    pos.findInRange(FIND_STRUCTURES, 1).filter(target => !isFull(target) && !isOwnedStructure(target))
  );
  if (structure) {
    creep.transfer(structure, RESOURCE_ENERGY);
    return;
  }
}

const strictEntries = <T extends Record<string, any>>(object: T): [keyof T, T[keyof T]][] => {
  return Object.entries(object);
};

function bodyByRatio(ratios: Partial<Record<BodyPartConstant, number>>, maxCost: number) {
  let partAmounts: Partial<Record<BodyPartConstant, number>> = {};
  let cost = 0;

  strictEntries(ratios).forEach(([part, _]) => {
    partAmounts[part] = 1;
    cost += BODYPART_COST[part];
  });

  for (;;) {
    //until break
    let nextPart = bodyPartToAddByRatio(ratios, partAmounts);

    if (cost + BODYPART_COST[nextPart] > maxCost) break;
    partAmounts[nextPart] = (partAmounts[nextPart] || 0) + 1;
    cost += BODYPART_COST[nextPart];
  }

  let body: BodyPartConstant[] = [];
  //  for (const part in partAmounts) {
  strictEntries(partAmounts).forEach(([part, amount]) => {
    for (let x = 1; x <= (amount || 0); x++) {
      body.push(part);
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

  strictEntries(ratios).forEach(([part, partRatio]) => {
    let amount = partAmounts[part];
    if (amount && partRatio) {
      let ratio = amount / partRatio;
      if (minRatio > ratio) {
        minRatio = ratio;
        nextPart = part;
      }
    }
  });

  return nextPart;
}

function handleRoom(room: Room) {
  //control the towers
  let towers = <StructureTower[]>(
    room.find(FIND_MY_STRUCTURES).filter(tower => tower.structureType === STRUCTURE_TOWER)
  );
  for (const t of towers) {
    handleTower(t);
  }

  handleHostilesInRoom(room);

  //construct some structures
  const structureTypes = [STRUCTURE_TOWER, STRUCTURE_EXTENSION, STRUCTURE_LINK, STRUCTURE_STORAGE];
  structureTypes.forEach(structureType => construct(room, structureType));

  //handle the links
  handleLinks(room);

  if (!room.memory.upgradeSpots) updateUpgradeSpots(room);
  if (!room.memory.harvestSpots) updateHarvestSpots(room);

  //check the room details
  checkRoomConstructionSiteCount(room);
  checkRoomStructureCount(room);
  checkRoomStatus(room);
  checkRoomCanHarvest(room);
  checkRoomEnergy(room);
}

function checkRoomConstructionSiteCount(room: Room) {
  let value = room.find(FIND_MY_CONSTRUCTION_SITES).length;
  if (room.memory.constructionSiteCount !== value) {
    msg(room, "Construction sites: " + room.memory.constructionSiteCount + " ➤ " + value, true);
    room.memory.constructionSiteCount = value;
  }
}

function checkRoomStructureCount(room: Room) {
  let value = room.find(FIND_STRUCTURES).length;
  if (room.memory.structureCount !== value) {
    msg(room, "Structures: " + room.memory.structureCount + " ➤ " + value, true);
    room.memory.structureCount = value;
  }
}

function checkRoomStatus(room: Room) {
  let value = roomStatus(room.name);
  if (room.memory.status !== value) {
    msg(room, "Status: " + room.memory.status + " ➤ " + value, true);
    room.memory.status = value;
  }
}

function checkRoomCanHarvest(room: Room) {
  let value = canHarvestInRoom(room);
  if (room.memory.canHarvest !== value) {
    msg(room, "Can harvest: " + room.memory.canHarvest + " ➤ " + value, true);
    room.memory.canHarvest = value;
  }
}

function checkRoomEnergy(room: Room) {
  let energy = room.energyAvailable;
  if (room.memory.energyAvailable > energy) {
    tryResetSpawnsAndExtensionsSorting(room);
  }
  room.memory.energyAvailable = energy;
}

function handleHostilesInRoom(room: Room) {
  //check for presence of hostiles
  let hostileCreeps = room.find(FIND_HOSTILE_CREEPS);
  let hostilePowerCreeps = room.find(FIND_HOSTILE_POWER_CREEPS);
  let totalHostiles = hostileCreeps.length + hostilePowerCreeps.length;
  let hostilesPresent = totalHostiles > 0;

  if (room.memory.hostilesPresent !== hostilesPresent) {
    if (hostilesPresent) {
      let hostileOwners = hostileCreeps
        .map(creep => creep.owner.username)
        .concat(hostilePowerCreeps.map(creep => creep.owner.username))
        .filter(onlyUnique);
      msg(room, totalHostiles + " hostiles from " + hostileOwners + " detected!", true);
    } else {
      msg(room, "clear from hostiles =)", true);
    }
    room.memory.hostilesPresent = hostilesPresent;
  }

  //enable safe mode if necessary
  if (hostilesPresent) {
    let towerCount = room
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
  let targetPos = room.controller.pos;
  let range = 3;
  const terrain = new Room.Terrain(room.name);
  let spots: RoomPosition[] = [];

  for (let x = targetPos.x - range; x <= targetPos.x + range; x++) {
    for (let y = targetPos.y - range; y <= targetPos.y + range; y++) {
      if (x === targetPos.x && y === targetPos.y) continue;
      if (terrain.get(x, y) === TERRAIN_MASK_WALL) continue;
      let pos = new RoomPosition(x, y, room.name);
      if (spots.includes(pos)) msg(room, pos + " already listed");
      spots.push(pos);
    }
  }
  room.memory.upgradeSpots = spots;
}

function updateHarvestSpots(room: Room) {
  msg(room, "Updating harvest spots");
  let range = 1;
  const terrain = new Room.Terrain(room.name);
  let spots: RoomPosition[] = [];

  room.find(FIND_SOURCES).forEach(source => {
    let targetPos = source.pos;

    for (let x = targetPos.x - range; x <= targetPos.x + range; x++) {
      for (let y = targetPos.y - range; y <= targetPos.y + range; y++) {
        if (x === targetPos.x && y === targetPos.y) continue;
        if (terrain.get(x, y) === TERRAIN_MASK_WALL) continue;
        let pos = new RoomPosition(x, y, room.name);
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

function handleLinks(room: Room) {
  //move energy towards lastEnergyConsumerPos
  let lastEnergyConsumerPos = room.memory.lastEnergyConsumerPos;
  if (!lastEnergyConsumerPos) return;
  let links = room
    .find(FIND_MY_STRUCTURES)
    .filter(isLink)
    .sort(function (x, y) {
      //sort: furthest/upstream -> closest/downstream
      if (!lastEnergyConsumerPos) return Number.POSITIVE_INFINITY;
      if (!("pos" in lastEnergyConsumerPos)) return Number.POSITIVE_INFINITY;
      return y.pos.getRangeTo(lastEnergyConsumerPos) - x.pos.getRangeTo(lastEnergyConsumerPos);
    });
  let upstreamIndex = 0;
  let downstreamIndex = links.length - 1;
  while (upstreamIndex < downstreamIndex) {
    let upstreamLink = links[upstreamIndex] as StructureLink;
    let downstreamLink = links[downstreamIndex] as StructureLink;

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

function handleTower(tower: StructureTower) {
  let bestTarget;
  let bestTargetScore = Number.NEGATIVE_INFINITY;
  let creeps = tower.room
    .find(FIND_CREEPS)
    .filter(target => target.my === false || target.hits < target.hitsMax / 2);
  for (const targetCreep of creeps) {
    let score = targetScore(tower, targetCreep);
    msg(tower, "target creep: " + targetCreep + ", score: " + score);
    if (bestTargetScore < score) {
      bestTargetScore = score;
      bestTarget = targetCreep;
    }
  }
  let myStructures = tower.room.find(FIND_MY_STRUCTURES).filter(target => target.hits < target.hitsMax / 2);
  for (const targetStructure of myStructures) {
    let score = targetScore(tower, targetStructure);
    if (bestTargetScore < score) {
      bestTargetScore = score;
      bestTarget = targetStructure;
    }
  }
  let structures = tower.room
    .find(FIND_STRUCTURES)
    .filter(target => !isOwnedStructure(target) || target.hits < target.hitsMax / 2);
  for (const targetStructure of structures) {
    let score = targetScore(tower, targetStructure);
    if (bestTargetScore < score) {
      bestTargetScore = score;
      bestTarget = targetStructure;
    }
  }
  let powerCreeps = tower.room
    .find(FIND_POWER_CREEPS)
    .filter(target => target.my === false || target.hits < target.hitsMax / 2);
  for (const targetPowerCreep of powerCreeps) {
    let score = targetScore(tower, targetPowerCreep);
    if (bestTargetScore < score) {
      bestTargetScore = score;
      bestTarget = targetPowerCreep;
    }
  }

  if (!bestTarget) return;

  msg(tower, "target: " + bestTarget);

  if ("my" in bestTarget && bestTarget.my === false) {
    tower.attack(bestTarget);
  } else if (bestTarget instanceof Creep || bestTarget instanceof PowerCreep) {
    tower.heal(bestTarget);
  } else {
    tower.repair(bestTarget);
  }
}

function targetScore(tower: StructureTower, target: Structure | Creep | PowerCreep) {
  let score = -tower.pos.getRangeTo(target);
  if ("my" in target) {
    if (target.my === false) score += 10;
    if (target.my === true) score -= 10;
  }
  if (target instanceof Creep) score += target.getActiveBodyparts(HEAL);
  return score;
}

function getDestinationFromMemory(creep: Creep) {
  let oldDestination = creep.memory.destination;
  let destination;

  if ((!creep.memory.empty && isEmpty(creep)) || (!creep.memory.full && isFull(creep))) {
    return resetDestination(creep); //abandon the old plan after getting full/empty
  } else if (oldDestination) {
    if (typeof oldDestination === "string") {
      destination = Game.getObjectById(oldDestination);
    } else if ("x" in oldDestination && "y" in oldDestination && "roomName" in oldDestination) {
      if (posEquals(creep.pos, oldDestination)) {
        creep.say("🛬");
        return resetDestination(creep); //abandon the old plan after reaching the target position
      } else {
        destination = new RoomPosition(oldDestination.x, oldDestination.y, oldDestination.roomName); //keep going
      }
    }

    if (
      creep.memory.action === "repair" &&
      destination &&
      "hits" in destination &&
      destination instanceof Structure &&
      !needsRepair(destination)
    ) {
      return resetDestination(creep); //abandon the old plan after repair target doesn't need any more repair
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

function destinationRoom(destination: Destination) {
  if ("roomName" in destination) return destination.roomName;
  if ("pos" in destination) return destination.pos.roomName;
  return;
}

function atEdge(pos: RoomPosition) {
  if (pos.x < 1 || pos.y < 1 || pos.x > 48 || pos.y > 48) return true;
  return false;
}

function memorizeCreepState(creep: Creep, destination: undefined | Destination | null | void) {
  if ((creep.memory.x || -1) !== creep.pos.x || (creep.memory.y || -1) !== creep.pos.y) {
    creep.memory.x = creep.pos.x;
    creep.memory.y = creep.pos.y;
    creep.memory.roomName = creep.pos.roomName;
    creep.memory.lastMoveTime = Game.time;
  }
  creep.memory.empty = isEmpty(creep);
  creep.memory.full = isFull(creep);
  if (destination) {
    let destinationPos = pos(destination);
    if (destinationPos && !posEquals(creep.pos, destinationPos)) {
      let range = creep.pos.getRangeTo(destinationPos);
      if (!isFinite(range)) {
        let rangeToExit = rangeToExitTowardsPos(creep.pos, destinationPos);
        if (rangeToExit) range = rangeToExit;
      }
      if (range) {
        if (creep.memory.rangeToDestination > range) {
          creep.memory.timeApproachedDestination = Game.time;
        }
        creep.memory.rangeToDestination = range;
      }
    }
  }
  updateConstructionSiteScoreForCreep(creep);
}

function rangeToExitTowardsPos(from: RoomPosition, to: RoomPosition) {
  let findExit = Game.map.findExit(from.roomName, to.roomName);
  if (findExit === ERR_NO_PATH) {
    msg("rangeToExitTowardsPos()", "no path between rooms: " + from + " - " + to);
  } else if (findExit === ERR_INVALID_ARGS) {
    msg(
      "rangeToExitTowardsPos()",
      "passed invalid arguments to Game.map.findExit(). Finding exit from " + from + " to " + to
    );
  } else {
    let exit = from.findClosestByPath(findExit);
    if (isRoomPosition(exit)) return from.getRangeTo(exit);
  }
  return;
}

function pos(object: Destination) {
  if (object instanceof RoomPosition) return object;
  if ("pos" in object) return object.pos;
  return;
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
  let role = creep.memory.role;
  let task;

  if (role === "worker") {
    task = getTaskForWorker(creep);
  } else if (role === "carrier") {
    task = getTaskForCarrier(creep);
  } else if (role === "spawner") {
    task = getTaskForSpawner(creep);
  } else if (role === "reserver") {
    let destination = closest(creep.pos, getReservableControllers());
    if (destination) task = { action: "reserveController", destination: destination };
  } else if (role === "explorer") {
    let destination = getExit(creep.pos);
    if (destination) task = { action: "moveTo", destination: destination };
  }

  if (task) {
    creep.memory.action = task.action;
    return task.destination;
  }
}

function getTaskForSpawner(creep: Creep) {
  let tasks: Task[] = [];
  if (!isFull(creep)) {
    let task = getEnergySourceTask(minTransferAmount(creep), creep.pos, true, true, false);
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
  let closest = undefined;
  let minRange = Number.POSITIVE_INFINITY;

  tasks.forEach(task => {
    //this only works inside a single room
    let range = pos.getRangeTo(task.destination);
    if (minRange > range) {
      minRange = range;
      closest = task;
    }
  });

  return closest || randomItem(tasks) /* we don't have ranges between rooms */;
}

function getTaskForCarrier(creep: Creep) {
  let tasks: Task[] = [];
  if (!isFull(creep)) {
    let task = getEnergySourceTask(minTransferAmount(creep), creep.pos, false, false, false);
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

function closest(pos: RoomPosition, options: Destination[]) {
  if (options.length < 1) return;
  let destination = pos.findClosestByPath(options); //same room
  if (destination) return destination;
  destination = randomItem(options); //another room
  return destination;
}

function getEnergyDestinations() {
  let targets: Structure[] = [];

  for (const i in Game.rooms) {
    let room = Game.rooms[i];
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

function getEnergySources(
  myMinTransfer: number,
  allowStorage = false,
  allowAnyLink = false,
  allowSource = false
) {
  let sources: any[] = [];

  for (const i in Game.rooms) {
    let room = Game.rooms[i];
    sources = sources
      .concat(room.find(FIND_DROPPED_RESOURCES).filter(resource => getEnergy(resource) >= myMinTransfer))
      .concat(room.find(FIND_TOMBSTONES).filter(tomb => getEnergy(tomb) >= myMinTransfer))
      .concat(room.find(FIND_RUINS).filter(ruin => getEnergy(ruin) >= myMinTransfer))
      .concat(
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
    if (allowSource && canHarvestInRoom(room)) {
      sources = sources.concat(room.find(FIND_SOURCES_ACTIVE));
    }
  }

  return sources;
}

function getEnergySourceTask(
  myMinTransfer: number,
  pos: RoomPosition,
  allowStorage = true,
  allowAnyLink = true,
  allowSource = true
) {
  let sources: any[] = [];

  for (const i in Game.rooms) {
    sources = sources.concat(
      getEnergyInRoom(Game.rooms[i], myMinTransfer, pos, allowStorage, allowAnyLink, allowSource)
    );
  }

  let destination = closest(pos, sources);
  if (!destination) return;

  let action: Action = "withdraw";
  if (destination instanceof Source) {
    action = "harvest";
  } else if (destination instanceof Resource) {
    action = "pickup";
  } else if (destination instanceof RoomPosition) {
    action = "moveTo";
  }

  return { action: action, destination: destination };
}

function getEnergyInRoom(
  room: Room,
  myMinTransfer: Number,
  pos: RoomPosition,
  allowStorage = true,
  allowAnyLink = true,
  allowSource = true
) {
  let sources: any[] = room
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
  if (allowSource && canHarvestInRoom(room)) {
    let activeSources = pos.findInRange(FIND_SOURCES_ACTIVE, 1);
    if (activeSources.length) {
      sources = sources.concat(activeSources);
    } else {
      sources = sources.concat(getAvailableHarvestSpots(room));
    }
  }
  return sources;
}

function action(creep: Creep, destination: Destination) {
  let actionOutcome;

  if (!destination) return;

  if (creep.memory.action === "repair" && destination instanceof Structure) {
    actionOutcome = creep.repair(destination);
  } else if (
    creep.memory.action === "withdraw" &&
    (destination instanceof Structure || destination instanceof Tombstone || destination instanceof Ruin)
  ) {
    actionOutcome = creep.withdraw(destination, RESOURCE_ENERGY);
    if (actionOutcome === OK) resetSpecificDestinationFromCreeps(destination);
  } else if (
    creep.memory.action === "transfer" &&
    (destination instanceof Creep || destination instanceof Structure)
  ) {
    actionOutcome = transfer(creep, destination);
    if (actionOutcome === OK) resetSpecificDestinationFromCreeps(destination);
  } else if (creep.memory.action === "upgradeController" && destination instanceof StructureController) {
    actionOutcome = creep.upgradeController(destination);
  } else if (
    creep.memory.action === "harvest" &&
    (destination instanceof Source || destination instanceof Mineral || destination instanceof Deposit)
  ) {
    actionOutcome = creep.harvest(destination);
    Memory.harvestersNeeded = true; //we need dedicated harvesters
  } else if (creep.memory.action === "pickup" && destination instanceof Resource) {
    actionOutcome = creep.pickup(destination);
    if (actionOutcome === OK) resetSpecificDestinationFromCreeps(destination);
  } else if (creep.memory.action === "moveTo") {
    let pathColor = hashColor(creep.memory.role);
    actionOutcome = creep.moveTo(destination, { visualizePathStyle: { stroke: pathColor } });
  } else if (creep.memory.action === "build" && destination instanceof ConstructionSite) {
    actionOutcome = creep.build(destination);
  } else if (creep.memory.action === "reserveController" && destination instanceof StructureController) {
    actionOutcome = creep.reserveController(destination);
  } else if (creep.memory.action) {
    msg(creep, "action() can't handle action: " + creep.memory.action, true);
  } else if (destination) {
    msg(creep, "action() doesn't have action for destination: " + destination, true);
  }

  if (actionOutcome !== undefined) {
    creep.memory.lastActionOutcome = actionOutcome;
    if (actionOutcome === OK) creep.memory.lastOkActionTime = Game.time;
  }
  return actionOutcome;
}

function resetSpecificDestinationFromCreeps(destination: Destination) {
  for (const i in Game.creeps) {
    let creep = Game.creeps[i];
    if (creep.memory.destination && "id" in destination && creep.memory.destination === destination.id) {
      resetDestination(creep);
    }
  }
}

function transfer(creep: Creep, destination: Creep | Structure<StructureConstant>) {
  let actionOutcome = creep.transfer(destination, RESOURCE_ENERGY);
  if (actionOutcome === OK && destination) {
    if ("memory" in destination) {
      destination.memory.timeOfLastEnergyReceived = Game.time;
      resetDestination(creep);
    }
    if (destination instanceof StructureSpawn || destination instanceof StructureExtension) {
      creep.room.memory.timeOfLastSpawnEnergyDelivery = Game.time;
      //First filled spawns/extensions should be used first, as they are probably easier to refill
      if (!creep.room.memory.sortedSpawnStructureIds) creep.room.memory.sortedSpawnStructureIds = [];
      if (!creep.room.memory.sortedSpawnStructureIds.includes(destination.id)) {
        creep.room.memory.sortedSpawnStructureIds.push(destination.id);
      }
    } else if (destination instanceof Creep) {
      //the receiver should reconsider what to do after getting the energy
      resetDestination(destination);
    }
  }
  return actionOutcome;
}

function postAction(creep: Creep, destination: Destination, actionOutcome: ScreepsReturnCode) {
  if (actionOutcome === OK) {
    creep.memory.lastOkActionTime = Game.time;
  } else if (destination) {
    if (actionOutcome === ERR_NOT_IN_RANGE && (destination instanceof RoomPosition || "pos" in destination)) {
      let pathColor = hashColor(creep.memory.role);
      creep.moveTo(destination, { visualizePathStyle: { stroke: pathColor } });
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
    } else if (actionOutcome === ERR_INVALID_TARGET) {
      creep.say("🔎");
      resetDestination(creep);
      if (destination instanceof Structure || destination instanceof RoomPosition)
        memorizeBlockedObject(creep, destination);
    } else if (actionOutcome === ERR_TIRED) {
      creep.say("😓");
    } else if (actionOutcome === ERR_NOT_OWNER) {
      creep.say("👮");
      resetDestination(creep);
      let exit = getExit(creep.pos);
      if (exit) {
        creep.memory.destination = exit;
        creep.memory.destinationSetTime = Game.time;
      }
    }
  }
}

function needsRepair(structure: Structure) {
  if (!structure) return false;
  if (isOwnedStructure(structure) && structure.my === false) return false;
  if (!structure.hits) return false;
  if (!structure.hitsMax) return false;
  if (structure.hits >= structure.hitsMax) return false;
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
  let destination = pos.findClosestByPath(
    pos
      .findInRange(FIND_MY_STRUCTURES, 3)
      .filter(target => target.my !== false && target.hits < target.hitsMax)
  );
  if (destination) return { action: "repair", destination: destination };
  let unowned = pos.findClosestByPath(
    pos
      .findInRange(FIND_STRUCTURES, 3)
      .filter(target => !isOwnedStructure(target) && target.hits < target.hitsMax)
  );
  if (unowned) return { action: "repair", destination: unowned };
  return;
}

function getBuildTaskInRange(pos: RoomPosition) {
  let destination = pos.findClosestByPath(pos.findInRange(FIND_MY_CONSTRUCTION_SITES, 3));
  if (destination) {
    return { action: "build", destination: destination };
  }
  return;
}

function getUpgradeTask(pos: RoomPosition, urgentOnly: boolean) {
  let targets = [];
  for (const i in Game.rooms) {
    let room = Game.rooms[i];
    if (!room.controller) continue;
    if (!room.controller.my) continue;
    if (urgentOnly && room.controller.ticksToDowngrade > 2000) continue;
    targets.push(room.controller);
  }
  let destination = closest(pos, targets);
  if (destination) return { action: "upgradeController", destination: destination };
  return;
}

function getAvailableHarvestSpots(room: Room) {
  let spots = room.memory.harvestSpots;
  let availableSpots: RoomPosition[] = [];

  spots.forEach(spot => {
    let pos = new RoomPosition(spot.x, spot.y, spot.roomName);
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
    let creep = Game.creeps[i];
    let destination = creep.memory.destination;
    if (destination instanceof RoomPosition && posEquals(destination, pos)) return true;
  }
  return false;
}

function getRepairTask(creep: Creep) {
  let destinations: any[] = [];

  for (const i in Game.rooms) {
    let room = Game.rooms[i];
    destinations = destinations.concat(
      room
        .find(FIND_STRUCTURES)
        .filter(
          target => worthRepair(creep.pos, target) && !isUnderRepair(target) && !isBlocked(creep, target)
        )
    );
  }

  let destination = closest(creep.pos, destinations);
  if (!destination) return;

  return { action: "repair", destination: destination };
}

function taskMoveRandomly(roomName: string) {
  let x = Math.floor(Math.random() * 10);
  let y = Math.floor(Math.random() * 10);
  return { action: "moveTo", destination: new RoomPosition(x, y, roomName) };
}

function workerSpendEnergyTask(creep: Creep) {
  //upgrade the room controller if it's about to downgrade
  let task = getUpgradeTask(creep.pos, true);
  //repair structures
  if (!task) task = getRepairTask(creep);
  //build structures
  if (!task) {
    let destination = closest(creep.pos, getConstructionSites(creep));
    if (destination) task = { action: "build", destination: destination };
  }
  //upgrade the room controller
  if (!task) task = getUpgradeTask(creep.pos, false);
  //return the final destination
  if (task) {
    if ("id" in task.destination) {
      let destinationRoomName = destinationRoom(task.destination);
      if (destinationRoomName) {
        if (task.destination instanceof RoomPosition)
          Memory.rooms[destinationRoomName].lastEnergyConsumerPos = task.destination;
        else if (task.destination.pos instanceof RoomPosition)
          Memory.rooms[destinationRoomName].lastEnergyConsumerPos = task.destination.pos;
      }
    }
    return task;
  }
  return;
}

function getConstructionSites(creep: Creep) {
  let sites: ConstructionSite[] = [];
  for (const i in Game.rooms) {
    let room = Game.rooms[i];
    sites = sites.concat(room.find(FIND_MY_CONSTRUCTION_SITES).filter(target => !isBlocked(creep, target)));
  }
  return sites;
}

function isUnderRepair(structure: Structure) {
  if (!structure) return false;
  if (!structure.id) return false;
  let creepsRepairingIt = Object.values(Game.creeps).filter(function (creep) {
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
  let hash = Md5.hashStr(seed);
  let offset = 0;
  let hex;
  let hsl;
  do {
    hex = hash.substring(0 + offset, 6 + offset);
    hsl = hexToHSL(hex);
    offset++;
  } while (!hsl || hsl["l"] < 0.6);
  //msg('hashColor',seed+' > '+hex+' > H:'+hsl['h']+', S:'+hsl['s']+', l:'+hsl['l']+' offset:'+offset);
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
  let maxRange = 6;
  return pos.findInRange(FIND_MY_STRUCTURES, maxRange).filter(isLink).length > 0;
}

function orderEnergy(creep: Creep) {
  //order energy from closest available carrier
  if (
    creep.memory.role === "worker" &&
    !creep.memory.awaitingDeliveryFrom &&
    (creep.memory.timeOfLastEnergyReceived || 0) < Game.time &&
    creep.store.getFreeCapacity(RESOURCE_ENERGY) >= minTransferAmount(creep)
  ) {
    let carriers = Object.values(Game.creeps).filter(function (carrier) {
      return carrier.memory.role === "carrier" && !isEmpty(carrier) && !hasImportantTask(carrier);
    });
    let carrier = creep.pos.findClosestByPath(carriers);
    if (carrier) {
      carrier.memory.action = "transfer";
      carrier.memory.destination = creep.id; //deliver to me
      carrier.memory.destinationSetTime = Game.time;
      creep.memory.awaitingDeliveryFrom = carrier.name; //my carrier
      creep.say(carrier.name);
    }
  }
}

function minTransferAmount(creep: Creep) {
  return creep.store.getCapacity(RESOURCE_ENERGY) / 10;
}

function tryResetSpawnsAndExtensionsSorting(room: Room) {
  //First filled spawns/extensions should be used first, as they are probably easier to refill
  //If none are full we can forget the old order and learn a new one
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
    let room = Game.rooms[i];
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

function shuffle(unshuffled: any[]) {
  if (!unshuffled) return unshuffled;

  return unshuffled
    .map(value => ({ value, sort: Math.random() }))
    .sort((a, b) => a.sort - b.sort)
    .map(({ value }) => value);
}

function canHarvestInRoom(room: Room) {
  if (!room.controller) return true; //no controller
  if (room.controller.my) return true; //my controller
  let reservation = room.controller.reservation;
  if (reservation && reservation.username === Memory.username) return true; //reserved to me
  if (!room.controller.owner && !room.controller.reservation) return true; //no owner & no reservation
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

function getExit(pos: RoomPosition) {
  if (!pos) return;
  let exits = Game.map.describeExits(pos.roomName);
  let accessibleRooms = Object.values(exits).filter(
    roomName => isRoomSafe(roomName, pos.roomName) && Memory.rooms[roomName].canHarvest
  );
  let destinationRoomName = randomItem(accessibleRooms);
  let findExit = Game.map.findExit(pos.roomName, destinationRoomName);
  if (findExit === ERR_NO_PATH) {
    msg(pos, "getExit(): no path between rooms: " + pos.roomName + " - " + destinationRoomName);
  } else if (findExit === ERR_INVALID_ARGS) {
    msg(pos, "getExit() passed invalid arguments to Game.map.findExit()");
  } else {
    let exit = pos.findClosestByPath(findExit);
    if (isRoomPosition(exit)) return exit;
  }
  return;
}

function randomItem(items: any[]) {
  return items[Math.floor(Math.random() * items.length)];
}

function updateConstructionSiteScoreForCreep(creep: Creep) {
  let creepX = creep.pos.x;
  let creepY = creep.pos.y;
  //lower the score for the occupied position and increase the score in the surrounding positions
  //the sum of the changes should add up to 0
  for (let x = creepX - 1; x <= creepX + 1; x++) {
    for (let y = creepY - 1; y <= creepY + 1; y++) {
      let value = creepX === x && creepY === y ? -8 : +1;
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
  //next to the link, controller and upgrade spots
  if (!room) return;
  let controller = room.controller;
  if (!controller) return;

  let targetPos;
  let link = controller.pos.findClosestByRange(FIND_MY_STRUCTURES, {
    filter: { structureType: STRUCTURE_LINK }
  });
  if (link) {
    targetPos = link.pos;
  } else {
    let site = controller.pos.findClosestByRange(FIND_MY_CONSTRUCTION_SITES, {
      filter: { structureType: STRUCTURE_LINK }
    });
    if (site) targetPos = site.pos;
  }
  if (!targetPos) return;
  if (targetPos.getRangeTo(controller.pos) > 6) return;

  let range = 1; //next to the link
  let bestScore = -1;
  let bestPos = undefined;
  const terrain = new Room.Terrain(room.name);

  for (let x = targetPos.x - range; x <= targetPos.x + range; x++) {
    for (let y = targetPos.y - range; y <= targetPos.y + range; y++) {
      if (x === targetPos.x && y === targetPos.y) continue;
      if (terrain.get(x, y) === TERRAIN_MASK_WALL) continue;
      let pos = new RoomPosition(x, y, room.name);
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

function getPrimaryPosForLink(room: Room) {
  //around controller and sources
  let range = 3;
  const terrain = new Room.Terrain(room.name);

  let placesRequiringLink = [];
  if (room.controller) placesRequiringLink.push(room.controller);
  placesRequiringLink = placesRequiringLink.concat(shuffle(room.find(FIND_SOURCES)));

  for (let i = 0; i < placesRequiringLink.length; i++) {
    let target = placesRequiringLink[i];
    if (target && !hasStructureInRange(target.pos, STRUCTURE_LINK, 6, true)) {
      let targetPos = target.pos;
      let bestScore = -1;
      let bestPos = undefined;

      for (let x = targetPos.x - range; x <= targetPos.x + range; x++) {
        for (let y = targetPos.y - range; y <= targetPos.y + range; y++) {
          if (x === targetPos.x && y === targetPos.y) continue;
          if (terrain.get(x, y) === TERRAIN_MASK_WALL) continue;
          let pos = new RoomPosition(x, y, room.name);
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

function countWorkSpotsAround(pos: RoomPosition, upgrade: boolean) {
  let spots = upgrade ? Memory.rooms[pos.roomName].upgradeSpots : Memory.rooms[pos.roomName].harvestSpots;
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

function getPosForContainer(room: Room) {
  let harvestSpots = room.memory.harvestSpots;

  if (!harvestSpots) return;

  let spots = shuffle(harvestSpots);
  for (let i = 0; i < spots.length; i++) {
    let spot = spots[i];
    let pos = new RoomPosition(spot.x, spot.y, spot.roomName);
    if (pos.lookFor(LOOK_STRUCTURES).length) continue;
    if (pos.lookFor(LOOK_CONSTRUCTION_SITES).length) continue;
    return pos;
  }
  return;
}

function adjustConstructionSiteScoreForLink(score: number, pos: RoomPosition) {
  //distance to exit decreases the score
  let penalty = pos.findClosestByPath(FIND_EXIT);
  if (penalty) {
    score /= pos.getRangeTo(penalty);
  }
  //distance to other links increases the score
  let shortestRange;
  let link = pos.findClosestByRange(FIND_MY_STRUCTURES, { filter: { structureType: STRUCTURE_LINK } });
  if (link) shortestRange = pos.getRangeTo(link);
  let linkSite = pos.findClosestByRange(FIND_MY_CONSTRUCTION_SITES, {
    filter: { structureType: STRUCTURE_LINK }
  });
  if (linkSite) {
    let range = pos.getRangeTo(linkSite);
    if (!shortestRange || shortestRange > range) shortestRange = range;
  }
  if (shortestRange) {
    score *= shortestRange;
  }
  return score;
}

function getPosForConstruction(room: Room, structureType: StructureConstant) {
  if (structureType === STRUCTURE_LINK) {
    let linkPos = getPrimaryPosForLink(room);
    if (linkPos) return linkPos;
  }
  if (structureType === STRUCTURE_STORAGE) return getPosForStorage(room);
  if (structureType === STRUCTURE_CONTAINER) return getPosForContainer(room);

  let scores = room.memory.constructionSiteScore;
  let bestScore = Number.NEGATIVE_INFINITY;
  let bestPos;

  for (let x = 2; x <= 47; x++) {
    for (let y = 2; y <= 47; y++) {
      if ((x + y) % 2 === 1) continue; //build in a checkered pattern to allow passage
      updateConstructionSiteScore(room, x, y, 0);
      let pos = room.getPositionAt(x, y);
      if (!pos) continue;
      if (!isPosSuitableForConstruction(pos)) continue;
      let score = scores[x][y];

      if (structureType === STRUCTURE_LINK) {
        score = adjustConstructionSiteScoreForLink(score, pos);
      } else if (structureType === STRUCTURE_EXTENSION) {
        //distance to source decreases the score
        let extensionPenalty = pos.findClosestByRange(FIND_SOURCES);
        if (extensionPenalty) {
          score /= pos.getRangeTo(extensionPenalty);
        }
      }

      if (bestScore < score) {
        bestScore = score;
        bestPos = pos;
      }
    }
  }

  return bestPos;
}

function isPosSuitableForConstruction(pos: RoomPosition) {
  let contents = pos.look();
  for (let i = 0; i < contents.length; i++) {
    let content = contents[i];
    if (content.type !== "terrain") return false;
    if (content.terrain === "wall") return false;
    if (isWorkerSpot(pos)) return false;
  }
  if (pos.findInRange(FIND_SOURCES, 2).length) return false;
  return true;
}

function isWorkerSpot(pos: RoomPosition) {
  let spots = Memory.rooms[pos.roomName].upgradeSpots.concat(Memory.rooms[pos.roomName].harvestSpots);
  for (let i = 0; i < spots.length; i++) {
    if (pos.x === spots[i].x && pos.y === spots[i].y) return true;
  }
  return false;
}

function getEnergy(object: Creep | AnyStructure | Resource | Ruin | Tombstone | Structure) {
  if (!object) return 0;
  let store = getStore(object);
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
  let room = spawn.room;

  //spawn creeps
  if (!spawn.spawning) {
    let roleToSpawn: Role;
    let body;

    if (getCreepCountByRole("spawner") < Object.keys(Game.creeps).length / 9) {
      roleToSpawn = "spawner";
    } else if (carriersNeeded()) {
      roleToSpawn = "carrier";
    } else if (harvestersNeeded(spawn.pos)) {
      spawnHarvester(spawn);
      return;
    } else if (getCreepCountByRole("reserver") < getReservableControllers().length) {
      roleToSpawn = "reserver";
    } else if (getCreepCountByRole("explorer") <= 0) {
      roleToSpawn = "explorer";
      body = [MOVE];
    } else if (room.energyAvailable >= room.energyCapacityAvailable) {
      roleToSpawn = "worker";
    } else {
      return;
    }

    let costOfCurrentCreepsInTheRole =
      Object.values(Game.creeps).reduce(
        (aggregated, item) => aggregated + (item.memory.role === roleToSpawn ? creepCost(item) : 0),
        0 /*initial*/
      ) || 0;
    let budget = Math.floor(Math.min(costOfCurrentCreepsInTheRole, room.energyCapacityAvailable));

    if (room.energyAvailable >= budget) {
      spawnCreep(spawn, roleToSpawn, budget, body);
    }
  }
}

function harvestersNeeded(pos: RoomPosition) {
  let source = getSourceToHarvest(pos);

  if (!source) return false; //nothing to harvest

  if (Memory.harvestersNeeded) return true;

  if (
    source.pos.findInRange(FIND_MY_STRUCTURES, 1).filter(target => target.structureType === STRUCTURE_LINK)
      .length > 0
  )
    return true; //always keep sources with link manned;

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
    sources = sources.concat(Game.rooms[r].find(FIND_SOURCES).filter(source => !sourceHasHarvester(source)));
  }
  if (sources.length < 1) return;
  let source = pos.findClosestByPath(sources); //same room
  if (source) return source;
  source = randomItem(sources); //another room
  return source;
}

function spawnHarvester(spawn: StructureSpawn) {
  let roleToSpawn: Role = "harvester"; //no energy for workers
  let source = getSourceToHarvest(spawn.pos);
  if (!source || !(source instanceof Source)) return;
  let workParts = source.energyCapacity / ENERGY_REGEN_TIME / HARVEST_POWER;
  let body: BodyPartConstant[] = [CARRY, MOVE];
  let partsToAdd: BodyPartConstant[] = [WORK, MOVE];
  for (let x = 1; x <= workParts; x++) {
    let newBody: BodyPartConstant[] = body.concat(partsToAdd);
    if (bodyCost(newBody) > spawn.room.energyCapacityAvailable) break;
    body = newBody;
  }
  if (bodyCost(body) > spawn.room.energyAvailable && getCreepCountByRole(roleToSpawn) < 1) {
    body = body.filter(onlyUnique);
  }
  let cost = bodyCost(body);
  if (cost > spawn.room.energyAvailable) return false;
  let energyStructures: (StructureSpawn | StructureExtension)[] = getSpawnsAndExtensionsSorted(spawn.room);
  let name = nameForCreep(roleToSpawn);
  let harvestPos = getHarvestSpotForSource(source);
  if (!harvestPos) return;
  constructContainerIfNeeded(harvestPos);
  let memory = initialCreepMemory(roleToSpawn, source.id, harvestPos, spawn.pos);
  if (spawn.spawnCreep(body, name, { memory: memory, energyStructures: energyStructures }) === OK) {
    Memory.harvestersNeeded = false;
    msg(
      spawn,
      "Spawning: " +
        roleToSpawn +
        " (" +
        name +
        "), cost: " +
        bodyCost(body) +
        "/" +
        spawn.room.energyAvailable +
        "/" +
        spawn.room.energyCapacityAvailable
    );
  }
  return true;
}

function getSpawnsAndExtensionsSorted(room: Room) {
  //First filled spawns/extensions should be used first, as they are probably easier to refill
  let all = room
    .find(FIND_MY_STRUCTURES)
    .filter(
      structure =>
        structure.structureType === STRUCTURE_EXTENSION || structure.structureType === STRUCTURE_SPAWN
    );

  return room.memory.sortedSpawnStructureIds
    .map(id => Game.getObjectById(id))
    .concat(shuffle(all))
    .filter(onlyUnique)
    .filter(isSpawnOrExtension);
}

function initialCreepMemory(
  role: Role,
  sourceId: undefined | Id<Source>,
  targetPos: undefined | RoomPosition,
  pos: RoomPosition
) {
  return {
    role: role,
    targetPos: targetPos,
    sourceId: sourceId,
    empty: true,
    full: false,
    timeApproachedDestination: Game.time,
    timeOfLastEnergyReceived: Game.time,
    lastOkActionTime: Game.time,
    rangeToDestination: 0,
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
    awaitingDeliveryFrom: undefined //Creep name
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
  let room = Game.rooms[source.pos.roomName];
  let bestSpot;
  let bestScore = Number.NEGATIVE_INFINITY;
  let targetPos = source.pos;
  let range = 1;
  const terrain = new Room.Terrain(room.name);

  for (let x = targetPos.x - range; x <= targetPos.x + range; x++) {
    for (let y = targetPos.y - range; y <= targetPos.y + range; y++) {
      if (x === targetPos.x && y === targetPos.y) continue;
      if (terrain.get(x, y) === TERRAIN_MASK_WALL) continue;
      let pos = new RoomPosition(x, y, room.name);
      if (blockedByStructure(pos)) continue;
      let score =
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
    let creep = Game.creeps[i];
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
  let totalEnergyToHaulBefore = Memory.time[Game.time - 100]?.totalEnergyToHaul;
  let totalEnergyToHaulNow = Memory.time[Game.time - 1]?.totalEnergyToHaul;
  return totalEnergyToHaulNow > totalEnergyToHaulBefore && totalEnergyToHaulNow > 1000;
}

function totalEnergyToHaul() {
  let energy = 0;
  for (const i in Game.rooms) {
    energy += Game.rooms[i]
      .find(FIND_STRUCTURES)
      .filter(structure => structure.structureType === STRUCTURE_CONTAINER)
      .reduce((aggregated, item) => aggregated + getEnergy(item), 0 /*initial*/);

    energy += Game.rooms[i]
      .find(FIND_DROPPED_RESOURCES)
      .reduce((aggregated, item) => aggregated + getEnergy(item), 0 /*initial*/);
  }
  return energy;
}

function spawnCreep(
  spawn: StructureSpawn,
  roleToSpawn: Role,
  energyAvailable: number,
  body: undefined | BodyPartConstant[]
) {
  /*  https://screeps.com/forum/topic/3044/how-does-each-bodypart-affect-fatigue/4
  Each body part except MOVE and empty CARRY generate fatigue.
  1 point per body part on roads, 2 on plain land, 10 on swamp.
  Each MOVE body part decreases fatigue points by 2 per tick.
  The creep cannot move when its fatigue is greater than zero.    */
  if (!body) {
    if (roleToSpawn === "worker") body = bodyByRatio({ move: 4, work: 3, carry: 1 }, energyAvailable);
    else if (roleToSpawn === "carrier" || roleToSpawn === "spawner")
      body = bodyByRatio({ move: 1, carry: 1 }, energyAvailable);
    else if (roleToSpawn === "reserver") body = bodyByRatio({ move: 1, claim: 1 }, energyAvailable);
  }
  let energyStructures = getSpawnsAndExtensionsSorted(spawn.room);
  let name = nameForCreep(roleToSpawn);

  if (!body || bodyCost(body) > spawn.room.energyAvailable) return;

  if (
    body &&
    spawn.spawnCreep(body, name, {
      memory: initialCreepMemory(roleToSpawn, undefined, undefined, spawn.pos),
      energyStructures: energyStructures
    }) === OK
  ) {
    msg(
      spawn,
      "Spawning: " +
        roleToSpawn +
        " (" +
        name +
        "), cost: " +
        bodyCost(body) +
        "/" +
        energyAvailable +
        "/" +
        spawn.room.energyCapacityAvailable
    );
  }
}

function msg(context: any, msg: string, email = false) {
  if (!msg) return;

  let contextDescription = "";
  if (context) {
    if (context.name) {
      contextDescription += context.name;
    } else {
      contextDescription += context;
    }
    if (context.room && context.room.name) contextDescription += " @ " + context.room.name;
    if (contextDescription) contextDescription += ": ";
  }

  let finalMsg = Game.time + " " + contextDescription + msg;
  console.log(finalMsg);
  if (email) Game.notify(finalMsg);
}

function nameForCreep(role: Role) {
  let characters = "ABCDEFGHJKLMNPQRTUVWXYZ2346789";
  let name = role.substring(0, 1).toUpperCase();
  while (Game.creeps[name]) {
    name += characters.charAt(Math.floor(Math.random() * characters.length));
  }
  return name;
}

function construct(room: Room, structureType: BuildableStructureConstant) {
  if (needStructure(room, structureType)) {
    let pos = getPosForConstruction(room, structureType);
    if (!pos) return;
    pos.lookFor(LOOK_STRUCTURES).forEach(structure => {
      if (structure instanceof StructureExtension) {
        msg(structure, "Destroying to make space for: " + structureType);
        structure.destroy();
      }
    });
    msg(room, "Creating a construction site for " + structureType + " at " + pos, true);
    pos.createConstructionSite(structureType);
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
  if (!room.controller) return false; //no controller
  if (!room.controller.my && room.controller.owner) return false; //owned by others
  let targetCount = CONTROLLER_STRUCTURES[structureType][room.controller.level];
  return targetCount > countStructures(room, structureType, true);
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
      creep.ticksToLive &&
      creep.ticksToLive >= minTicksToLive
    );
  }).length;
}

function bodyCost(body: BodyPartConstant[]) {
  return body.reduce(function (cost, part) {
    return cost + BODYPART_COST[part];
  }, 0);
}

function onlyUnique(value: any, index: number, self: any[]) {
  /*  usage example:
      let a = ['a', 1, 'a', 2, '1'];
      let unique = a.filter(onlyUnique);
      console.log(unique); // ['a', 1, 2, '1']
  */
  return self.indexOf(value) === index;
}

function hasImportantTask(creep: Creep) {
  let destinationId = creep.memory.destination;
  if (!destinationId) return false;
  if (destinationId instanceof RoomPosition) return false;
  let destination = Game.getObjectById(destinationId);
  if (!destination) return false;
  return destination instanceof Creep;
}

function resetDestination(creep: Creep) {
  //save last values
  creep.memory.lastDestination = creep.memory.destination;
  creep.memory.lastAction = creep.memory.action;
  //reset properties
  if (!creep.memory.destination) return;
  let destination;
  if (!(creep.memory.destination instanceof RoomPosition))
    destination = Game.getObjectById(creep.memory.destination);
  creep.memory.destination = undefined;
  creep.memory.destinationSetTime = Game.time;
  creep.memory.timeApproachedDestination = Game.time;
  creep.memory.action = undefined;
  if (destination && "memory" in destination && destination.memory.awaitingDeliveryFrom) {
    destination.memory.awaitingDeliveryFrom = undefined;
  }

  return;
}

function isEmpty(object: Structure | Creep) {
  if (!object) return false;
  let store = getStore(object);
  if (!store) return false;
  return store.getUsedCapacity(RESOURCE_ENERGY) <= 0;
}
function isFull(object: Structure | Creep) {
  if (!object) return false;
  let store = getStore(object);
  if (!store) return false;
  return store.getFreeCapacity(RESOURCE_ENERGY) <= 0;
}
function fillRatio(object: Structure | Creep) {
  if (!object) return 0;
  let store = getStore(object);
  if (!store) return 0;
  return store.getUsedCapacity(RESOURCE_ENERGY) / store.getCapacity(RESOURCE_ENERGY);
}

function hexToHSL(hex: string) {
  let result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!result) return;
  let r = parseInt(result[1], 16);
  let g = parseInt(result[2], 16);
  let b = parseInt(result[3], 16);
  (r /= 255), (g /= 255), (b /= 255);
  let max = Math.max(r, g, b),
    min = Math.min(r, g, b);
  let h,
    s,
    l = (max + min) / 2;
  if (max === min) {
    h = s = 0; // achromatic
  } else {
    let d = max - min;
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
  return { h: h, s: s, l: l };
}

function handleCreep(creep: Creep) {
  if (creep.spawning) return;

  let destination = getDestinationFromMemory(creep);

  if (creep.memory.awaitingDeliveryFrom && !Game.creeps[creep.memory.awaitingDeliveryFrom]) {
    creep.memory.awaitingDeliveryFrom = undefined; //no longer await delivery from a dead creep
  }

  //create a new plan if situation requires
  if (!destination && (!creep.memory.awaitingDeliveryFrom || atEdge(creep.pos))) {
    destination = getNewDestination(creep);
    if (destination) setDestination(creep, destination);
  }

  if (destination) {
    let actionOutcome = action(creep, destination);
    if (actionOutcome) postAction(creep, destination, actionOutcome);

    if (
      (creep.memory.timeApproachedDestination > (creep.memory.lastOkActionTime || 0) ||
        (destination instanceof RoomPosition && creep.memory.rangeToDestination > 0)) &&
      creep.memory.timeApproachedDestination < Game.time - 25
    ) {
      msg(
        creep,
        "timeout! time: " +
          Game.time +
          " timeApproachedDestination: " +
          creep.memory.timeApproachedDestination
      );
      creep.say("⌛️");
      resetDestination(creep);
      memorizeBlockedObject(creep, destination);
    }
  }

  memorizeCreepState(creep, destination);
}

function getTaskForWorker(creep: Creep) {
  if (creep.memory.awaitingDeliveryFrom && atEdge(creep.pos)) return taskMoveRandomly(creep.pos.roomName);

  if (isFull(creep)) {
    //spend energy without moving
    let task = getRepairTaskInRange(creep.pos) || getBuildTaskInRange(creep.pos);
    if (task) return task;
  }

  //order more energy
  if (!useLink(creep)) orderEnergy(creep);

  if (isEmpty(creep) && !creep.memory.awaitingDeliveryFrom) {
    //fetch nearby energy
    let allowSource = getCreepCountByRole("harvester") < 1;
    let task = getEnergySourceTask(minTransferAmount(creep), creep.pos, true, true, allowSource);
    if (task) {
      return task;
    }
    return { action: "moveTo", destination: getExit(creep.pos) };
  } else if (!isEmpty(creep)) {
    //use energy
    return workerSpendEnergyTask(creep);
  }
  return;
}
