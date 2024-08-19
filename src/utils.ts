// Memory.printCpuInfo=true;

// Type guards
export function isStorage(structure: Structure | Ruin | Tombstone | Resource): structure is StructureStorage {
  if (!("structureType" in structure)) return false;
  return structure.structureType === STRUCTURE_STORAGE;
}
export function isController(structure: Structure): structure is StructureController {
  if (!("structureType" in structure)) return false;
  return structure.structureType === STRUCTURE_CONTROLLER;
}
export function isContainer(
  structure: Structure | EnergySource | AnyStoreStructure
): structure is StructureContainer {
  if (!("structureType" in structure)) return false;
  return structure.structureType === STRUCTURE_CONTAINER;
}
export function isRoad(structure: Structure): structure is StructureRoad {
  if (!("structureType" in structure)) return false;
  return structure.structureType === STRUCTURE_ROAD;
}
export function isDestructibleWall(structure: Structure): structure is StructureWall {
  return structure.structureType === STRUCTURE_WALL && "hits" in structure;
}
export function isInvaderCore(structure: Structure): structure is StructureInvaderCore {
  return structure.structureType === STRUCTURE_INVADER_CORE;
}
export function isLink(structure: Structure | Ruin | Tombstone | Resource): structure is StructureLink {
  if (!("structureType" in structure)) return false;
  return structure.structureType === STRUCTURE_LINK;
}
export function isTower(structure: Structure): structure is StructureTower {
  return structure.structureType === STRUCTURE_TOWER;
}
export function isObserver(structure: Structure): structure is StructureObserver {
  return structure.structureType === STRUCTURE_OBSERVER;
}
export function isSpawnOrExtension(
  structure: Structure | null | undefined | Destination
): structure is StructureSpawn | StructureExtension {
  if (!structure) return false;
  if (!("structureType" in structure)) return false;
  return structure.structureType === STRUCTURE_SPAWN || structure.structureType === STRUCTURE_EXTENSION;
}
export function isSpawn(structure: Structure | null | undefined | Destination): structure is StructureSpawn {
  if (!structure) return false;
  if (!("structureType" in structure)) return false;
  return structure.structureType === STRUCTURE_SPAWN;
}
export function isRoomPosition(item: RoomPosition): item is RoomPosition {
  return item instanceof RoomPosition;
}
export function isStoreStructure(
  item: Structure | undefined | Ruin | Tombstone | Resource | AnyStructure | null
): item is AnyStoreStructure {
  if (!item) return false;
  return "store" in item;
}

export function isOwnedStoreStructure(
  item: AnyOwnedStructure
): item is AnyOwnedStructure & AnyStoreStructure {
  if (!item) return false;
  return "store" in item;
}

function getStore(object: Creep | AnyStructure | Resource | Ruin | Tombstone | Structure) {
  if ("store" in object) return object.store;
  if ("getUsedCapacity" in object) return object;
  return;
}

export function isFull(object: Structure | Creep | Ruin | Resource | Tombstone): boolean {
  if (!object) return false;
  const store = getStore(object) as StoreBase<RESOURCE_ENERGY, false>;
  if (!store) return false;
  return store.getFreeCapacity(RESOURCE_ENERGY) <= 0;
}

export function hasSpace(object: Structure | Creep | Ruin | Resource | Tombstone): boolean {
  if (!object) return false;
  const store = getStore(object) as StoreBase<RESOURCE_ENERGY, false>;
  if (!store) return false;
  return store.getFreeCapacity(RESOURCE_ENERGY) > 0;
}

export function getFillRatio(object: Structure | Creep | Resource | Tombstone | Ruin): number {
  if (!object) return 0;
  const store = getStore(object) as StoreBase<RESOURCE_ENERGY, false>;
  if (!store) return 0;
  return store.getUsedCapacity(RESOURCE_ENERGY) / store.getCapacity(RESOURCE_ENERGY);
}

export function getEnergy(object: Creep | AnyStructure | Resource | Ruin | Tombstone | Structure): number {
  if (!object) return 0;
  const store = getStore(object) as StoreBase<RESOURCE_ENERGY, false>;
  if (store) return store.getUsedCapacity(RESOURCE_ENERGY);
  if ("energy" in object) return object.energy;
  return 0;
}

export function getFreeCap(object: Creep | AnyStructure | Resource | Ruin | Tombstone | Structure): number {
  if (!object) return Number.NEGATIVE_INFINITY;
  const store = getStore(object) as StoreBase<RESOURCE_ENERGY, false>;
  if (store) return store.getFreeCapacity(RESOURCE_ENERGY);
  return Number.NEGATIVE_INFINITY;
}

export function getPos(obj: RoomPosition | RoomObject | null | undefined): RoomPosition | undefined {
  if (!obj) return;
  if (obj instanceof RoomPosition) return obj;
  if ("pos" in obj) return obj.pos;
  return;
}

export function getGlobalCoords(pos: RoomPosition): { x: number; y: number } {
  if (!pos) throw new Error("Missing pos!");
  const roomCoords = /([WE])(\d+)([NS])(\d+)/g.exec(pos.roomName);
  if (!roomCoords || roomCoords.length < 5) return { x: 0, y: 0 };

  let xOffset = 0;
  if (roomCoords[1] === "E") xOffset = Number(roomCoords[2]) * 50;
  else if (roomCoords[1] === "W") xOffset = (Number(roomCoords[2]) + 1) * -50;
  const x = pos.x + xOffset;

  let yOffset = 0;
  if (roomCoords[3] === "S") yOffset = Number(roomCoords[4]) * 50;
  else if (roomCoords[3] === "N") yOffset = (Number(roomCoords[4]) + 1) * -50;
  const y = pos.y + yOffset;

  return { x, y };
}

export function getGlobalRange(from: RoomPosition | undefined, to: RoomPosition | undefined): number {
  if (!from || !to) return Number.POSITIVE_INFINITY;
  const fromGlobal = getGlobalCoords(from);
  const toGlobal = getGlobalCoords(to);
  const range = Math.max(Math.abs(fromGlobal.x - toGlobal.x), Math.abs(fromGlobal.y - toGlobal.y));
  return range;
}

export function cpuInfo(): void {
  if (Memory.printCpuInfo) {
    msg(
      "cpuInfo()",
      Game.cpu.getUsed().toString() + "/" + Game.cpu.limit.toString() + " CPU used!\n" + getCpuLog()
    );
    Memory.printCpuInfo = false;
  } else if (Game.cpu.getUsed() >= Game.cpu.tickLimit) {
    msg(
      "cpuInfo()",
      Game.cpu.getUsed().toString() +
        "/" +
        Game.cpu.limit.toString() +
        " CPU used! To get detailed log use: Memory.printCpuInfo=true;"
    );
  }
}

export function getCpuLog(): string {
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

export function msg(
  context:
    | StructureSpawn
    | Structure
    | AnyStructure
    | Room
    | Creep
    | PowerCreep
    | RoomPosition
    | string
    | Flag,
  text: string,
  email = false
): void {
  if (!text) return;
  const finalMsg = Game.time.toString() + " " + getObjectDescription(context) + ": " + text;
  console.log(finalMsg);
  if (email) Game.notify(finalMsg);
}

export function shouldMaintainStatsFor(pos: RoomPosition): boolean {
  // to save CPU, gather stats for only part of the rooms and switch focus after certain interval
  const sections = 2;
  const interval = 10000;
  return pos.x % sections === Math.floor(Game.time / interval) % sections;
}

export function getAccessiblePositionsAround(
  origin: RoomPosition,
  rangeMin: number,
  rangeMax: number,
  excludeBlocked: boolean
): RoomPosition[] {
  const terrain = new Room.Terrain(origin.roomName);
  const spots: RoomPosition[] = [];

  const minX = Math.max(0, origin.x - rangeMax);
  const maxX = Math.min(49, origin.x + rangeMax);
  const minY = Math.max(0, origin.y - rangeMax);
  const maxY = Math.min(49, origin.y + rangeMax);
  for (let x = minX; x <= maxX; x++) {
    for (let y = minY; y <= maxY; y++) {
      if (Math.max(Math.abs(origin.x - x), Math.abs(origin.y - y)) < rangeMin) continue;
      if (terrain.get(x, y) === TERRAIN_MASK_WALL) continue;
      const pos = new RoomPosition(x, y, origin.roomName);
      if (excludeBlocked && blockedByStructure(pos)) continue;
      spots.push(pos);
    }
  }
  return spots
    .map(value => ({ value, sort: Math.random() })) /* persist sort values */
    .sort((a, b) => b.sort - a.sort) /* sort */
    .map(({ value }) => value); /* remove sort values */
}

export function getPositionsAround(origin: RoomPosition, rangeMin: number, rangeMax: number): RoomPosition[] {
  const spots: RoomPosition[] = [];

  const minX = Math.max(0, origin.x - rangeMax);
  const maxX = Math.min(49, origin.x + rangeMax);
  const minY = Math.max(0, origin.y - rangeMax);
  const maxY = Math.min(49, origin.y + rangeMax);
  for (let x = minX; x <= maxX; x++) {
    for (let y = minY; y <= maxY; y++) {
      if (Math.max(Math.abs(origin.x - x), Math.abs(origin.y - y)) < rangeMin) continue;
      const pos = new RoomPosition(x, y, origin.roomName);
      spots.push(pos);
    }
  }
  return spots;
}

export function getPositionsAroundWithTerrainSpace(
  origin: RoomPosition,
  positionRangeMin: number,
  positionRangeMax: number,
  spaceRangeMin: number,
  spaceRangeMax: number
): RoomPosition[] {
  const terrain = new Room.Terrain(origin.roomName);
  return getPositionsAround(origin, positionRangeMin, positionRangeMax)
    .map(pos => ({
      pos,
      terrain: terrain.get(pos.x, pos.y)
    }))
    .filter(pos => pos.terrain !== TERRAIN_MASK_WALL)
    .map(item => ({
      ...item,
      surroundings: getPositionsAround(item.pos, spaceRangeMin, spaceRangeMax).map(pos2 => ({
        pos: pos2,
        terrain: terrain.get(pos2.x, pos2.y)
      }))
    }))
    .map(item => ({
      ...item,
      plains: item.surroundings.filter(item2 => item2.terrain === 0).length,
      swamps: item.surroundings.filter(item2 => item2.terrain === TERRAIN_MASK_SWAMP).length
    }))
    .map(item => ({
      ...item,
      score: item.swamps + item.plains * 10 + (item.terrain === 0 ? 100 : 0)
    }))
    .sort((a, b) => b.score - a.score) /* descending */
    .map(item => item.pos);
}

export function setUsername(): void {
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

export function logCpu(name: string): void {
  if (!Memory.cpuLog) return;
  if (!(name in Memory.cpuLog)) {
    Memory.cpuLog[name] = { before: Game.cpu.getUsed(), after: Game.cpu.getUsed() };
  } else {
    Memory.cpuLog[name].after = Game.cpu.getUsed();
  }
}

export function blockedByStructure(pos: RoomPosition): boolean {
  return pos.lookFor(LOOK_STRUCTURES).filter(isObstacle).length > 0;
}

export function isObstacle(structure: Structure): boolean {
  return (OBSTACLE_OBJECT_TYPES as StructureConstant[]).includes(structure.structureType);
}

export function getControllersToReserve(): StructureController[] {
  const controllers: StructureController[] = [];
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
  const sorted = controllers
    .map(value => ({ value, sort: value?.reservation?.ticksToEnd || 0 }))
    .sort((a, b) => a.sort - b.sort)
    .map(({ value }) => value);

  return sorted;
}

export function creepsHaveDestination(structure: Structure): boolean {
  if (!structure) return false;
  if (!structure.id) return false;
  if (
    Object.values(Game.creeps).filter(function (creep) {
      return creep.memory.destination === structure.id;
    }).length
  ) {
    return true;
  }

  return false;
}

export function shouldReserveRoom(room: Room): boolean {
  const controller = room.controller;
  if (!isRoomSafe(room.name)) return false;
  if (!controller) return false;
  if (controller.owner) return false;
  if (isReservationOk(controller)) return false;
  if (isReservedByOthers(controller)) return false;
  return true;
}

export function isReservationOk(controller: StructureController): boolean {
  if (controller.my) return true;
  const reservation = controller.reservation;
  if (!reservation) return false;
  if (reservation.username !== Memory.username) return false;
  if (reservation.ticksToEnd < 2500) return false;
  return true;
}

export function isRoomReservationOk(roomName: string): boolean {
  const controller = Game.rooms[roomName]?.controller;
  if (!controller) return false;
  return isReservationOk(controller);
}

export function isReservedByOthers(controller: StructureController): boolean {
  const reservation = controller.reservation;
  if (!reservation) return false;
  if (reservation.username !== Memory.username) return true;
  return false;
}

export function setDestinationFlag(name: string, pos: RoomPosition): void {
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

export function getTotalCreepCapacity(role: Role | undefined): number {
  return Object.values(Game.creeps).reduce(
    (aggregated, creep) =>
      aggregated +
      (!role || creep.name.startsWith(role.charAt(0).toUpperCase())
        ? creep.store.getCapacity(RESOURCE_ENERGY)
        : 0),
    0 /* initial*/
  );
}

export function canOperateInRoom(room: Room): boolean {
  if (!room.controller) return true; // no controller
  if (room.controller.my) return true; // my controller
  const reservation = room.controller.reservation;
  if (reservation && reservation.username === Memory.username) return true; // reserved to me
  if (room.find(FIND_HOSTILE_STRUCTURES).filter(isInvaderCore).length > 0) return false;
  if (!room.controller.owner && !reservation) return true; // no owner & no reservation
  return false;
}

export function canOperateInSurroundingRooms(roomName: string): boolean {
  return (
    Object.values(Game.map.describeExits(roomName)).filter(
      exitRoomName => !Memory.rooms[exitRoomName]?.canOperate
    ).length < 1
  );
}

export function getRoomStatus(roomName: string): "normal" | "closed" | "novice" | "respawn" {
  return Game.map.getRoomStatus(roomName).status;
}

export function isRoomSafe(roomName: string): boolean {
  return Memory.rooms[roomName]?.safeForCreeps ?? true;
}

export function getPosOfLinkByTheController(controller: StructureController): RoomPosition | undefined {
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

export function getPrimaryPosForLink(room: Room): RoomPosition | undefined {
  const placesRequiringLink: (StructureStorage | Source)[] = getPlacesRequiringLink(room);

  for (const target of placesRequiringLink) {
    if (target && !hasStructureInRange(target.pos, STRUCTURE_LINK, 2, true)) {
      const targetPos = target.pos;
      let bestScore = Number.NEGATIVE_INFINITY;
      let bestPos;
      const creepSpots = getSurroundingPlains(targetPos, 1, 1, true);

      for (const creepSpot of creepSpots) {
        const linkSpots = getSurroundingPlains(creepSpot, 1, 1, true);
        for (const linkSpot of linkSpots) {
          let score = getSurroundingPlains(linkSpot, 1, 1, true).length;
          if (hasStructureInRange(linkSpot, undefined, 1, true)) score -= 0.1;
          if (bestScore < score) {
            bestScore = score;
            bestPos = linkSpot;
          }
        }
      }

      if (bestPos) return bestPos;
    }
  }
  return;
}

export function getPosForStorage(room: Room): RoomPosition | undefined {
  if (
    !room ||
    !room.controller ||
    !room.controller.my ||
    getStructureCount(room, STRUCTURE_STORAGE, true) > 0
  )
    return;

  let bestScore = Number.NEGATIVE_INFINITY;
  let bestPos;

  for (const pos of getAccessiblePositionsAround(room.controller.pos, 2, 2, true)) {
    const score =
      (getSurroundingPlains(pos, 1, 1).length -
        pos.findInRange(FIND_STRUCTURES, 1).filter(isObstacle).length) *
        100 +
      (getSurroundingPlains(pos, 1, 2).length -
        pos.findInRange(FIND_STRUCTURES, 2).filter(isObstacle).length);
    if (bestScore < score) {
      bestScore = score;
      bestPos = pos;
    }
  }
  return bestPos;
}

export function getPlacesRequiringLink(room: Room): (StructureStorage | Source)[] {
  let placesRequiringLink: (StructureStorage | Source)[] = room.find(FIND_MY_STRUCTURES).filter(isStorage);
  placesRequiringLink = placesRequiringLink.concat(
    room
      .find(FIND_SOURCES)
      .map(value => ({ value, sort: Math.random() })) /* persist sort values */
      .sort((a, b) => a.sort - b.sort) /* sort */
      .map(({ value }) => value) /* remove sort values */
  );
  return placesRequiringLink;
}

export function hasStructureInRange(
  pos: RoomPosition,
  structureType: StructureConstant | undefined,
  range: number,
  includeConstructionSites: boolean
): boolean {
  if (
    pos
      .findInRange(FIND_STRUCTURES, range)
      .filter(structure => !structureType || structure.structureType === structureType).length > 0
  )
    return true;

  if (
    includeConstructionSites &&
    pos
      .findInRange(FIND_CONSTRUCTION_SITES, range)
      .filter(structure => !structureType || structure.structureType === structureType).length > 0
  )
    return true;

  return false;
}

export function adjustConstructionSiteScoreForLink(score: number, pos: RoomPosition): number {
  // distance to exit decreases the score
  const penalty = pos.findClosestByRange(FIND_EXIT);
  if (penalty) {
    score /= getGlobalRange(pos, penalty);
    score /= getGlobalRange(pos, penalty);
  }
  // distance to other links increases the score
  let shortestRange;
  const link = pos.findClosestByRange(FIND_MY_STRUCTURES, { filter: { structureType: STRUCTURE_LINK } });
  if (link) shortestRange = getGlobalRange(pos, link.pos);
  const linkSite = pos.findClosestByRange(FIND_MY_CONSTRUCTION_SITES, {
    filter: { structureType: STRUCTURE_LINK }
  });
  if (linkSite) {
    const range = getGlobalRange(pos, linkSite.pos);
    if (!shortestRange || shortestRange > range) shortestRange = range;
  }
  if (shortestRange) {
    score *= shortestRange;
  }
  return score;
}

export function getPotentialConstructionSites(room: Room): ScoredPos[] {
  const sites: ScoredPos[] = [];

  for (let x = 4; x <= 45; x++) {
    for (let y = 4; y <= 45; y++) {
      if ((x + y) % 2 === 1) continue; // build in a checkered pattern to allow passage
      const pos = room.getPositionAt(x, y);
      if (!pos) continue;
      if (!isPosSuitableForConstruction(pos)) continue;
      const score =
        (hasStructureInRange(pos, STRUCTURE_ROAD, 1, true) ? 10 : 5) -
        pos.lookFor(LOOK_STRUCTURES).length +
        getSurroundingPlains(pos, 0, 1).length;
      sites.push({ score, pos });
    }
  }
  return sites;
}

export function getSurroundingPlains(
  pos: RoomPosition,
  rangeMin: number,
  rangeMax: number,
  allowSwamp = false
): RoomPosition[] {
  const plains = [];
  const positions = getAccessiblePositionsAround(pos, rangeMin, rangeMax, true);
  const terrain = new Room.Terrain(pos.roomName);
  for (const posAround of positions) {
    const type = terrain.get(posAround.x, posAround.y);
    if (type === 0 || (type === TERRAIN_MASK_SWAMP && allowSwamp)) plains.push(posAround);
  }
  return plains;
}

export function isPosSuitableForConstruction(pos: RoomPosition): boolean {
  const contents = pos.look();
  for (const content of contents) {
    if (content.type !== "terrain") return false;
    if (content.terrain === "wall") return false;
    if (hasStructureInRange(pos, STRUCTURE_STORAGE, 2, true)) return false;
    if (hasStructureInRange(pos, STRUCTURE_CONTROLLER, 2, true)) return false;
    if (hasStructureInRange(pos, STRUCTURE_LINK, 2, true)) return false;
  }
  if (pos.findInRange(FIND_SOURCES, 2).length) return false;
  return true;
}

export function getTarget(
  myUnit: StructureTower | Creep,
  maxRange: number | undefined
): Creep | PowerCreep | Structure | undefined {
  const creep = getTargetCreep(myUnit, maxRange);

  const powerCreep = getTargetPowerCreep(myUnit, maxRange);

  const structure = getTargetStructure(myUnit, maxRange);

  const targets = [];
  if (creep) targets.push(creep);
  if (powerCreep) targets.push(powerCreep);
  if (structure) targets.push(structure);

  if (targets.length < 1) return;

  const best = targets.sort((a, b) => b.score - a.score)[0].target;

  return best;
}

export function getTargetScore(pos: RoomPosition, target: Structure | Creep | PowerCreep): number {
  let score = -pos.getRangeTo(target);
  if ("my" in target) {
    if (target.my === false) score += 10;
    if (target.my === true) score -= 10;
  }
  if (target instanceof Creep) score += target.getActiveBodyparts(HEAL);
  return score;
}

export function isEdge(pos: RoomPosition): boolean {
  if (pos.x <= 0) return true;
  if (pos.y <= 0) return true;
  if (pos.x >= 49) return true;
  if (pos.y >= 49) return true;
  return false;
}

export function setDestination(creep: Creep, destination: Destination): void {
  if (destination && creep.memory.destination !== ("id" in destination ? destination.id : destination)) {
    if ("id" in destination) {
      creep.memory.destination = destination.id;
    } else if (destination instanceof RoomPosition) {
      creep.memory.destination = destination;
      setDestinationFlag(creep.name, destination);
    }
  }
}

export function checkRoomCanOperate(room: Room): void {
  const value = canOperateInRoom(room);
  if (room.memory && room.memory.canOperate !== value) {
    msg(
      room,
      "Can operate: " + (room.memory.canOperate || "-").toString() + " ➤ " + (value || "-").toString()
    );
    room.memory.canOperate = value;
  }
}

export function handleHostilesInRoom(room: Room): void {
  const hostileBody = room.find(FIND_HOSTILE_CREEPS)[0]?.body.map(part => part.type);
  if (hostileBody) Memory.hostileCreepCost = getBodyCost(hostileBody);
  room.memory.claimIsSafe =
    (room.controller?.safeMode || 0) > 300 ||
    room.find(FIND_HOSTILE_CREEPS).filter(hostile => isThreatToRoom(hostile)).length < 1;
  room.memory.safeForCreeps =
    (room.controller?.safeMode || 0) > 300 ||
    (room.find(FIND_HOSTILE_CREEPS).filter(hostile => isThreatToCreep(hostile)).length < 1 &&
      room
        .find(FIND_HOSTILE_STRUCTURES)
        .filter(isTower)
        .filter(tower => getEnergy(tower) > 0).length < 1);
  if (!room.memory.claimIsSafe) activateSafeModeIfNeed(room);
}

export function isThreatToRoom(target: Creep): boolean {
  return (
    !target.my &&
    (target.getActiveBodyparts(ATTACK) > 0 ||
      target.getActiveBodyparts(RANGED_ATTACK) > 0 ||
      target.getActiveBodyparts(CLAIM) > 0)
  );
}

export function isThreatToCreep(target: Creep): boolean {
  return (
    !target.my && (target.getActiveBodyparts(ATTACK) > 0 || target.getActiveBodyparts(RANGED_ATTACK) > 0)
  );
}

export function activateSafeModeIfNeed(room: Room): void {
  const structureTypesToProtect: StructureConstant[] = [
    STRUCTURE_EXTENSION,
    STRUCTURE_FACTORY,
    STRUCTURE_LAB,
    STRUCTURE_NUKER,
    STRUCTURE_OBSERVER,
    STRUCTURE_POWER_SPAWN,
    STRUCTURE_SPAWN,
    STRUCTURE_STORAGE,
    STRUCTURE_TERMINAL,
    STRUCTURE_TOWER
  ];

  // key structures not badly damaged?
  if (
    room
      .find(FIND_MY_STRUCTURES)
      .filter(s => s.hits < s.hitsMax / 2 && structureTypesToProtect.includes(s.structureType)).length < 1
  )
    return;

  // save the one simultaneous safe mode for a room with higher RCL?
  const maxRclWithAvailableSafeModes = Object.values(Game.rooms)
    .filter(
      myRoom =>
        myRoom.controller?.my &&
        myRoom.controller?.safeModeAvailable > 0 &&
        !myRoom.controller?.safeModeCooldown
    )
    .reduce((max, myRoom) => Math.max(max, myRoom.controller?.level ?? 0), 0 /* initial*/);
  if ((room.controller?.level ?? 0) < maxRclWithAvailableSafeModes) return;

  // OK, let's activate it!
  if (room.controller && room.controller?.my) {
    const outcome = room.controller.activateSafeMode();
    if (outcome === OK) msg(room.controller, "safe mode activated!", true);
  }
}

export function getHostileUsernames(hostileCreeps: Creep[], hostilePowerCreeps: PowerCreep[]): string[] {
  return hostileCreeps
    .map(creep => creep.owner.username)
    .concat(hostilePowerCreeps.map(creep => creep.owner.username))
    .filter((value, index, self) => self.indexOf(value) === index); // unique
}

export function getLinkDownstreamPos(room: Room): RoomPosition | undefined {
  if (room.storage) return room.storage.pos;
  const flagName = room.name + "_EnergyConsumer";
  if (!(flagName in Game.flags)) return;
  const flag = Game.flags[flagName];
  const destination = flag.pos;

  return destination;
}

export function handleLinks(room: Room): void {
  // move energy towards the energy consumer
  const downstreamPos = getLinkDownstreamPos(room);

  if (!downstreamPos) return;

  const links = getSortedLinks(room, downstreamPos);

  let upstreamIndex = 0;
  let downstreamIndex = links.length - 1;
  while (upstreamIndex < downstreamIndex) {
    const upstreamLink = links[upstreamIndex];
    const downstreamLink = links[downstreamIndex];

    if (getEnergy(upstreamLink) < 1 || upstreamLink.cooldown) {
      upstreamIndex++;
    } else if (getFillRatio(downstreamLink) >= 0.9) {
      downstreamIndex--;
    } else {
      upstreamLink.transferEnergy(downstreamLink);
      upstreamIndex++;
    }
  }
}

export function getSortedLinks(room: Room, downstreamPos: RoomPosition): StructureLink[] {
  const links = room
    .find(FIND_MY_STRUCTURES)
    .filter(isLink)
    .map(value => ({ value, sort: value.pos.getRangeTo(downstreamPos) })) /* persist sort values */
    .sort((a, b) => b.sort - a.sort) /* sort */
    .map(({ value }) => value); /* remove sort values */

  return links;
}

export function canAttack(myUnit: StructureTower | Creep): boolean {
  if (myUnit instanceof StructureTower) return true;
  if (myUnit.getActiveBodyparts(ATTACK) > 0) return true;
  if (myUnit.getActiveBodyparts(RANGED_ATTACK) > 0) return true;
  return false;
}
export function canHeal(myUnit: StructureTower | Creep): boolean {
  if (myUnit instanceof StructureTower) return true;
  if (myUnit.getActiveBodyparts(HEAL) > 0) return true;
  return false;
}

export function getTargetCreep(
  myUnit: StructureTower | Creep,
  maxRange: number | undefined
): ScoredTarget | undefined {
  let bestTarget;
  let bestTargetScore = Number.NEGATIVE_INFINITY;
  const creeps = myUnit.room
    .find(FIND_CREEPS)
    .filter(
      target =>
        ((canAttack(myUnit) && target.my === false) ||
          (canHeal(myUnit) && target.my !== false && target.hits < target.hitsMax)) &&
        (!maxRange || myUnit.pos.getRangeTo(target) <= maxRange)
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

export function getTargetPowerCreep(
  myUnit: StructureTower | Creep,
  maxRange: number | undefined
): ScoredTarget | undefined {
  let bestTarget;
  let bestTargetScore = Number.NEGATIVE_INFINITY;
  const powerCreeps = myUnit.room
    .find(FIND_POWER_CREEPS)
    .filter(
      target =>
        ((canAttack(myUnit) && target.my === false) ||
          (canHeal(myUnit) && target.my !== false && target.hits < target.hitsMax)) &&
        (!maxRange || myUnit.pos.getRangeTo(target) <= maxRange)
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

export function getTargetStructure(
  myUnit: StructureTower | Creep,
  maxRange: number | undefined
): ScoredTarget | undefined {
  if (!canAttack(myUnit)) return;
  let bestTarget;
  let bestTargetScore = Number.NEGATIVE_INFINITY;
  const structures = myUnit.room
    .find(FIND_HOSTILE_STRUCTURES)
    .filter(target => !maxRange || myUnit.pos.getRangeTo(target) <= maxRange);
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

export function shouldHarvestRoom(room: Room): boolean {
  if (!isRoomSafe(room.name)) return false;
  if (!room) return false;
  if (room.controller?.my) return true;
  const exits = Game.map.describeExits(room.name);
  return (
    Object.values(exits).filter(roomName => Game.rooms[roomName] && Game.rooms[roomName].controller?.my)
      .length > 0
  );
}

export function getCreepCountByRole(role: Role, minTicksToLive = 120): number {
  const count = Object.values(Game.creeps).filter(function (creep) {
    return (
      creep.name.startsWith(role.charAt(0).toUpperCase()) &&
      (!creep.ticksToLive || creep.ticksToLive >= minTicksToLive)
    );
  }).length;

  return count;
}

export function getBodyCost(body: BodyPartConstant[]): number {
  return body.reduce(function (cost, part) {
    return cost + BODYPART_COST[part];
  }, 0);
}

export function needStructure(room: Room, structureType: BuildableStructureConstant): boolean {
  if (!room.controller) return false; // no controller
  if (!room.controller.my && room.controller.owner) return false; // owned by others
  const targetCount = CONTROLLER_STRUCTURES[structureType][room.controller.level];
  return targetCount > getStructureCount(room, structureType, true);
}

export function getStructureCount(
  room: Room,
  structureType: StructureConstant,
  includeConstructionSites: boolean
): number {
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

export function resetDestination(creep: Creep): void {
  delete creep.memory.destination;
  const flag = Game.flags["creep_" + creep.name];
  if (flag) flag.remove();
  return;
}

export function getOwnedRoomsCount(): number {
  return Object.values(Game.rooms).filter(room => room.controller?.my).length;
}

export function getUpgradeableControllerCount(): number {
  const count = Object.values(Game.rooms).filter(
    room =>
      room.controller?.my &&
      (room.controller?.level < 8 || room.controller?.ticksToDowngrade < 100000) &&
      room.controller.pos
        .findInRange(FIND_STRUCTURES, 3)
        .filter(structure => isStorage(structure) || (isContainer(structure) && getEnergy(structure))).length
  ).length;

  return count;
}

export function updateRoomScore(room: Room): void {
  let score = 0;
  const sources = room.find(FIND_SOURCES);
  const controller = room.controller;
  if (controller) {
    for (const source of sources) {
      const path = PathFinder.search(source.pos, controller.pos);
      score += 1 / path.cost;
    }
  }
  room.memory.score = score;
}

const fillableStructureTargetCount =
  CONTROLLER_STRUCTURES[STRUCTURE_SPAWN][8] +
  CONTROLLER_STRUCTURES[STRUCTURE_EXTENSION][8] +
  CONTROLLER_STRUCTURES[STRUCTURE_TOWER][8];

export function updateRoomLayout(room: Room): void {
  // only move on to the next phase once earlier phases are complete (we don't want to build ramparts around partial base for example)
  // Game.rooms.E53S2.memory.resetLayout=true;
  if (room.memory.resetLayout) {
    resetLayout(room);
    return;
  } else if (room.controller?.my && canOperateInRoom(room)) {
    // design owned room
    if (!room.controller) return;
    if (!flagStorage(room)) return;
    if (!flagStorageSubstituteContainer(room)) return;
    if (!flagLinkForStorage(room)) return;
    if (!flagSourceContainers(room)) return;
    if (!flagSourceLinks(room)) return;
    if (!flagFillables(room)) return;
    if (!flagSpawns(room)) return;
    if (!flagTowers(room)) return;
    if (!flagObserver(room)) return;
    if (!flagRoads(room)) return;
    if (!flagRampartsOnStructures(room)) return;
    if (!flagRampartsAroundBase(room)) return;
    if (!unFlagUnnecessaryContainers(room)) return;
    if (!createConstructionSitesOnFlags(room)) return;
    if (!removeConstructionSitesWithoutFlags(room)) return;
    if (!destroyStructuresWithoutFlags(room)) return;
  } else if (isRoomReservationOk(room.name)) {
    // design reserved room
    if (!room.controller) return;
    if (!flagSourceContainers(room)) return;
    if (!createConstructionSitesOnFlags(room)) return;
    if (!removeConstructionSitesWithoutFlags(room)) return;
    if (!destroyStructuresWithoutFlags(room)) return;
  }
}

function resetLayout(room: Room) {
  const flags = room.find(FIND_FLAGS);
  for (const flag of flags) flag.remove();
  delete room.memory.resetLayout;
}

export function getObjectDescription(obj: Destination | undefined | string | Room): string {
  if (!obj) return "";
  if (typeof obj === "string") return obj;
  let description = obj.toString();
  if ("pos" in obj) description += " @ " + obj.pos.toString();
  return description;
}

export function gotSpareCpu(): boolean {
  return Game.cpu.tickLimit >= (Memory.maxTickLimit ?? 0) && (Memory.cpuUsedRatio ?? 0) < 0.9;
}

export function hslToHex(h: number /* deg */, s: number /* % */, l: number /* % */): string {
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

export function isPosEqual(a: RoomPosition, b: RoomPosition): boolean {
  if (!a || !b) return false;
  if (a.x !== b.x) return false;
  if (a.y !== b.y) return false;
  if (a.roomName !== b.roomName) return false;
  return true;
}

export function getCachedCostMatrix(roomName: string): CostMatrix {
  const costMem = Memory.rooms[roomName]?.costMatrix;
  if (costMem) return PathFinder.CostMatrix.deserialize(costMem);
  return new PathFinder.CostMatrix();
}

export function getCachedCostMatrixCreeps(roomName: string): CostMatrix {
  const costMem = Memory.rooms[roomName]?.costMatrixCreeps;
  if (costMem) return PathFinder.CostMatrix.deserialize(costMem);
  return new PathFinder.CostMatrix();
}

export function getCachedCostMatrixLayout(roomName: string): CostMatrix {
  const costMem = Memory.rooms[roomName]?.costMatrixLayout;
  if (costMem) return PathFinder.CostMatrix.deserialize(costMem);
  return new PathFinder.CostMatrix();
}

export function getCachedCostMatrixRamparts(roomName: string): CostMatrix {
  const costMem = Memory.rooms[roomName]?.costMatrixRamparts;
  if (costMem) return PathFinder.CostMatrix.deserialize(costMem);
  return new PathFinder.CostMatrix();
}

export function getCachedCostMatrixSafe(roomName: string): CostMatrix {
  const costMem = Memory.rooms[roomName]?.costMatrixCreeps;
  if (costMem) {
    const costs = PathFinder.CostMatrix.deserialize(costMem);
    const exits = Game.map.describeExits(roomName);
    for (const [direction, exitRoomName] of Object.entries(exits)) {
      if (!isRoomSafe(exitRoomName)) {
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

export function getPath(from: RoomPosition, to: RoomPosition, range = 0, safe = true): RoomPosition[] {
  return PathFinder.search(
    from,
    { pos: to, range },
    {
      plainCost: 2,
      swampCost: 10,
      roomCallback: safe ? getCachedCostMatrixSafe : getCachedCostMatrix
    }
  ).path;
}

export function getPosBetween(pos1: RoomPosition, pos2: RoomPosition): RoomPosition {
  return getSurroundingPlains(pos1, 0, 1, true)
    .filter(pos => pos.isNearTo(pos2.x, pos2.y))
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

function flagStorage(room: Room) {
  const structureType = STRUCTURE_STORAGE;
  if (getStructureFlags(room, structureType).length >= CONTROLLER_STRUCTURES[structureType][8]) return true;
  const controllerPos = room.controller?.pos;
  if (!controllerPos) return false;
  const pos = getPositionsAroundWithTerrainSpace(controllerPos, 2, 2, 1, 1).find(
    posAround => posAround.lookFor(LOOK_FLAGS).length < 1
  );
  if (pos) flagStructure(pos, structureType);
  return false;
}

function flagLinkForStorage(room: Room) {
  const structureType = STRUCTURE_LINK;
  const withoutLink = getStructureFlags(room, STRUCTURE_STORAGE).filter(
    storage =>
      storage.pos.findInRange(FIND_FLAGS, 2).filter(flag => flag.name.startsWith(structureType + "_"))
        .length < 1
  );
  if (withoutLink.length < 1) return true;
  for (const storage of withoutLink) {
    const pos = getPositionsAroundWithTerrainSpace(storage.pos, 2, 2, 1, 1)[0];
    if (pos) flagStructure(pos, structureType);
  }
  return false;
}

function flagStorageSubstituteContainer(room: Room) {
  if (CONTROLLER_STRUCTURES[STRUCTURE_STORAGE][room?.controller?.level ?? 0] > 0) return true; // we don't need a container, when a storage is available
  const structureType = STRUCTURE_CONTAINER;
  const controller = room.controller;
  if (!controller) return false;
  if (
    controller.pos.findInRange(FIND_FLAGS, 2).filter(flag => flag.name.startsWith(structureType + "_"))
      .length > 0
  )
    return true; // already got a container
  const pos = getPositionsAroundWithTerrainSpace(controller.pos, 2, 2, 1, 1).find(
    posAround => posAround.lookFor(LOOK_FLAGS).length < 1
  );
  if (pos) flagStructure(pos, structureType);
  return false;
}

function flagStructure(pos: RoomPosition, structureType: string) {
  const coords = getGlobalCoords(pos);
  pos.createFlag(
    structureType + "_" + coords.x.toString() + "_" + coords.y.toString(),
    getColor(structureType + "1"),
    getColor(structureType + "2")
  );
}

function getColor(seed: string): ColorConstant {
  if (!Memory.color) Memory.color = {};
  let color = Memory.color[seed];
  if (color) return color;
  color = getRandomColor();
  Memory.color[seed] = color;
  return color;
}

function getRandomColor(): ColorConstant {
  const colors = [
    COLOR_RED,
    COLOR_PURPLE,
    COLOR_BLUE,
    COLOR_CYAN,
    COLOR_GREEN,
    COLOR_YELLOW,
    COLOR_ORANGE,
    COLOR_BROWN,
    COLOR_GREY,
    COLOR_WHITE
  ];

  const randomIndex = Math.floor(Math.random() * colors.length);
  return colors[randomIndex];
}

function flagFillables(room: Room) {
  // flag spawns, extensions and towers as extensions initially and in a later phase change some into spawns and towers
  const currentCount =
    getStructureFlags(room, STRUCTURE_SPAWN).length +
    getStructureFlags(room, STRUCTURE_EXTENSION).length +
    getStructureFlags(room, STRUCTURE_TOWER).length;
  if (currentCount >= fillableStructureTargetCount || !room.controller) return true;

  const storages = getStructureFlags(room, STRUCTURE_STORAGE);
  const positionsRequiringSpace = storages
    .map(s => s.pos)
    .concat([room.controller.pos])
    .concat(getStructureFlags(room, STRUCTURE_CONTAINER).map(s => s.pos))
    .concat(getStructureFlags(room, STRUCTURE_LINK).map(s => s.pos));
  const existingPositions = storages.concat(getStructureFlags(room, STRUCTURE_EXTENSION));
  const randomIndex = Math.floor(Math.random() * existingPositions.length);
  const startPos = existingPositions[randomIndex]?.pos;
  const allowSwampProbability = 0.02; // allow & discourage
  let exitMargin = 7;
  while (exitMargin > 1 && Math.random() < 0.2) exitMargin--; // allow & discourage
  if (!startPos) return false;
  const plains = getSurroundingPlains(startPos, 1, 1, Math.random() < allowSwampProbability).filter(
    p => p.findInRange(FIND_EXIT, exitMargin).length < 1
  );
  for (const pos of plains) {
    const plains2 = getSurroundingPlains(pos, 1, 1, Math.random() < allowSwampProbability).filter(
      p => p.findInRange(FIND_EXIT, exitMargin).length < 1
    );
    for (const pos2 of plains2) {
      const plains3 = getSurroundingPlains(pos2, 1, 1, Math.random() < allowSwampProbability).filter(
        p => p.findInRange(FIND_EXIT, exitMargin).length < 1
      );
      for (const pos3 of plains3) {
        const flagCount = pos3.lookFor(LOOK_FLAGS).length;
        if (flagCount < 1 && pos3.findInRange(positionsRequiringSpace, 1).length < 1) {
          flagStructure(pos3, roadOrExtension(pos3));
        }
      }
    }
  }
  return false;
}

function roadOrExtension(pos: RoomPosition): string {
  return (pos.x - pos.y) % 4 === 0 || (pos.x + pos.y) % 4 === 0 ? STRUCTURE_ROAD : STRUCTURE_EXTENSION;
}

function getStructureFlags(room: Room, structureType: string) {
  return room.find(FIND_FLAGS).filter(flag => flag.name.startsWith(structureType + "_"));
}

function flagSourceContainers(room: Room) {
  if (isEnoughLinksAvailable(room)) return true; // we don't need a container, when enough links are available for all sources & storage
  const structureType = STRUCTURE_CONTAINER;
  const sourcesWithout = room
    .find(FIND_SOURCES)
    .filter(
      source =>
        source.pos.findInRange(FIND_FLAGS, 1).filter(flag => flag.name.startsWith(structureType + "_"))
          .length < 1
    );
  if (sourcesWithout.length < 1) return true; // no sources without container
  for (const source of sourcesWithout) {
    const containerPos = getPositionsAroundWithTerrainSpace(source.pos, 1, 1, 1, 1)[0];
    if (containerPos) flagStructure(containerPos, structureType);
  }
  return false;
}

function flagSourceLinks(room: Room) {
  const structureType = STRUCTURE_LINK;
  const sources = room.find(FIND_SOURCES);
  const harvestSpotsWithoutLink = [];
  for (const source of sources) {
    const containers = source.pos
      .findInRange(FIND_FLAGS, 1)
      .filter(flag => flag.name.startsWith(STRUCTURE_CONTAINER + "_"));
    const harvestSpot = containers[0]?.pos ?? getPositionsAroundWithTerrainSpace(source.pos, 1, 1, 1, 1)[0];
    if (
      harvestSpot.findInRange(FIND_FLAGS, 1).filter(flag => flag.name.startsWith(structureType + "_"))
        .length < 1
    )
      harvestSpotsWithoutLink.push(harvestSpot);
  }
  if (harvestSpotsWithoutLink.length < 1) return true;
  for (const harvestPos of harvestSpotsWithoutLink) {
    const targetPos = getPositionsAroundWithTerrainSpace(harvestPos, 1, 1, 1, 1)[0];
    if (targetPos) flagStructure(targetPos, structureType);
  }
  return false;
}

function flagSpawns(room: Room) {
  const structureType = STRUCTURE_SPAWN;
  if (getStructureFlags(room, structureType).length >= CONTROLLER_STRUCTURES[structureType][8]) return true;
  const controllerPos = room.controller?.pos;
  if (!controllerPos) return false;
  const extension = controllerPos.findClosestByRange(getStructureFlags(room, STRUCTURE_EXTENSION));
  if (!extension) return false;
  flagStructure(extension.pos, structureType);
  extension.remove();
  return false;
}

function flagTowers(room: Room) {
  const structureType = STRUCTURE_TOWER;
  if (getStructureFlags(room, structureType).length >= CONTROLLER_STRUCTURES[structureType][8]) return true;
  const exits = room.find(FIND_EXIT);
  const randomIndex = Math.floor(Math.random() * exits.length);
  const exit = exits[randomIndex];
  if (!exit) return false;
  const extensions = getStructureFlags(room, STRUCTURE_EXTENSION);
  if (extensions.length < 1) return false;
  const extension = exit.findClosestByPath(extensions);
  if (!extension) return false;
  flagStructure(extension.pos, structureType);
  extension.remove();
  return false;
}

function flagObserver(room: Room) {
  const structureType = STRUCTURE_OBSERVER;
  if (getStructureFlags(room, structureType).length >= CONTROLLER_STRUCTURES[structureType][8]) return true;
  const extensions = getStructureFlags(room, STRUCTURE_EXTENSION);
  if (extensions.length < 1) return false;
  const randomIndex = Math.floor(Math.random() * extensions.length);
  const extension = extensions[randomIndex];
  if (!extension) return false;
  const allowSwampProbability = 0.02; // allow & discourage
  const pos = getSurroundingPlains(extension.pos, 1, 1, Math.random() < allowSwampProbability).find(
    posAround => posAround.lookFor(LOOK_FLAGS).length < 1
  );
  if (pos) flagStructure(pos, structureType);
  return false;
}

function flagRoads(room: Room) {
  const structureType = STRUCTURE_ROAD;
  const { from, to } = getRoadTargets(room);
  if (!from || !to) return false;
  room.memory.costMatrixLayout = getFreshCostMatrixLayout(room).serialize();
  const path = PathFinder.search(
    from.pos,
    { pos: to.pos, range: 0 },
    {
      // planned road: 1, planned structure: 20
      plainCost: 3,
      swampCost: 10,
      roomCallback: getCachedCostMatrixLayout,
      heuristicWeight: 1 /* lower is more accurate, but uses more CPU */,
      maxRooms: 2
    }
  ).path;
  const newRoads = path.filter(
    pos => pos.lookFor(LOOK_FLAGS).filter(flag => flag.name.startsWith(structureType + "_")).length < 1
  );
  for (const pos of newRoads) {
    flagStructure(pos, structureType);
    const obstacles = pos.lookFor(LOOK_FLAGS).filter(flag => structureFlagIsObstacle(flag));
    for (const obstacle of obstacles) obstacle.remove();
  }
  return true;
}

function getRoadTargets(room: Room) {
  const structureType = STRUCTURE_ROAD;
  let fromPositions;
  let toPositions;
  if (Math.random() < 0.5) {
    // connect storage and containers by road
    fromPositions = getStructureFlags(room, STRUCTURE_STORAGE);
    toPositions = getStructureFlags(room, STRUCTURE_CONTAINER);
    const remoteHarvestRoomNames = Object.values(Game.map.describeExits(room.name)).filter(exitRoomName =>
      isRoomReservationOk(exitRoomName)
    );
    for (const remoteHarvestRoomName of remoteHarvestRoomNames) {
      const remoteHarvestRoom = Game.rooms[remoteHarvestRoomName];
      toPositions = toPositions.concat(getStructureFlags(remoteHarvestRoom, STRUCTURE_CONTAINER));
      Memory.rooms[remoteHarvestRoomName].costMatrixLayout =
        getFreshCostMatrixLayout(remoteHarvestRoom).serialize();
    }
  } else {
    // make sure all roads are connected to each other
    const roads = getStructureFlags(room, structureType);
    fromPositions = roads;
    toPositions = roads;
  }
  const from = fromPositions[Math.floor(Math.random() * fromPositions.length)];
  const to = toPositions[Math.floor(Math.random() * toPositions.length)];
  return { from, to };
}

function getFreshCostMatrixLayout(room: Room) {
  const costs = new PathFinder.CostMatrix();
  if (!room) return costs;
  const flags = room.find(FIND_FLAGS);
  const roads = flags.filter(flag => flag.name.startsWith(STRUCTURE_ROAD + "_"));
  for (const road of roads) costs.set(road.pos.x, road.pos.y, 1);
  const obstacles = flags
    .filter(flag => structureFlagIsObstacle(flag))
    .map(f => f.pos)
    .concat(
      room
        .find(FIND_STRUCTURES) /* constructed walls and stuff*/
        .filter(isObstacle)
        .map(o => o.pos)
    );
  // try to avoid structures, but go through them if alternatives are too far
  for (const structure of obstacles) costs.set(structure.x, structure.y, 20);
  return costs;
}

function getFreshCostMatrixRamparts(room: Room) {
  const costs = new PathFinder.CostMatrix();
  if (!room) return costs;
  const ramparts = getStructureFlags(room, STRUCTURE_RAMPART);
  for (const rampart of ramparts) costs.set(rampart.pos.x, rampart.pos.y, 255);
  return costs;
}

function structureFlagIsObstacle(flag: Flag) {
  const structureTypes = [
    "constructedWall",
    "extension",
    "factory",
    "lab",
    "link",
    "nuker",
    "observer",
    "powerBank",
    "powerSpawn",
    "spawn",
    "storage",
    "terminal",
    "tower"
  ];
  return structureTypes.some(type => flag.name.startsWith(type + "_"));
}

function structureFlagRequiresRampart(flag: Flag) {
  const structureTypes = [
    STRUCTURE_FACTORY,
    STRUCTURE_LAB,
    STRUCTURE_SPAWN,
    STRUCTURE_STORAGE,
    STRUCTURE_TERMINAL,
    STRUCTURE_TOWER
  ];
  return structureTypes.some(type => flag.name.startsWith(type + "_"));
}

function structureFlagIsBase(flag: Flag) {
  const structureTypes = [
    STRUCTURE_EXTENSION,
    STRUCTURE_SPAWN,
    STRUCTURE_STORAGE,
    STRUCTURE_TOWER,
    STRUCTURE_OBSERVER,
    STRUCTURE_POWER_SPAWN,
    STRUCTURE_LAB,
    STRUCTURE_TERMINAL,
    STRUCTURE_NUKER,
    STRUCTURE_FACTORY
  ];
  return structureTypes.some(type => flag.name.startsWith(type + "_"));
}

function flagRampartsOnStructures(room: Room) {
  const structureType = STRUCTURE_RAMPART;
  const rampartsRequired = room
    .find(FIND_FLAGS)
    .filter(
      structureRequiringRampart =>
        structureFlagRequiresRampart(structureRequiringRampart) &&
        structureRequiringRampart.pos
          .lookFor(LOOK_FLAGS)
          .filter(rampart => rampart.name.startsWith(structureType + "_")).length < 1
    );
  for (const flag of rampartsRequired) flagStructure(flag.pos, structureType);
  return true;
}

function flagRampartsAroundBase(room: Room) {
  const exits = room.find(FIND_EXIT);
  const randomIndex = Math.floor(Math.random() * exits.length);
  const exit = exits[randomIndex];
  if (!exit) return false;
  const goals = room
    .find(FIND_FLAGS)
    .filter(flag => structureFlagIsBase(flag))
    .map(flag => ({
      pos: flag.pos,
      range: 3
    }));
  if (goals.length < 1) return false;
  room.memory.costMatrixRamparts = getFreshCostMatrixRamparts(room).serialize();
  const pathResult = PathFinder.search(exit, goals, {
    plainCost: 1,
    swampCost: 1,
    roomCallback: getCachedCostMatrixRamparts,
    heuristicWeight: 1 /* lower is more accurate, but uses more CPU */,
    maxRooms: 1
  });
  if (pathResult.incomplete) return true;
  const rampartPos = pathResult.path[pathResult.path.length - 1];
  if (rampartPos) flagStructure(rampartPos, STRUCTURE_RAMPART);
  return false;
}

function unFlagUnnecessaryContainers(room: Room) {
  const structureType = STRUCTURE_CONTAINER;
  const unnecessaryContainers = getStructureFlags(room, structureType).filter(
    container => !isContainerFlagNecessary(container)
  );
  for (const container of unnecessaryContainers) container.remove();
  return unnecessaryContainers.length < 1;
}

function isContainerFlagNecessary(container: Flag) {
  const room = container.room;
  if (!room) return;

  const nearbySources = container.pos.findInRange(FIND_SOURCES, 1);
  if (nearbySources.length > 0 && !isEnoughLinksAvailable(room)) return true;

  const controller = room.controller;
  if (
    controller &&
    container.pos.getRangeTo(controller) <= 2 &&
    CONTROLLER_STRUCTURES[STRUCTURE_STORAGE][room?.controller?.level ?? 0] < 1
  )
    return true;

  return false;
}

function isEnoughLinksAvailable(room: Room) {
  // we are able to build one link for each storage and source
  return (
    CONTROLLER_STRUCTURES[STRUCTURE_LINK][room?.controller?.level ?? 0] >=
    room.find(FIND_SOURCES).length + CONTROLLER_STRUCTURES[STRUCTURE_STORAGE][room?.controller?.level ?? 0]
  );
}

const prioritizedStructureTypes = [
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

function createConstructionSitesOnFlags(room: Room) {
  const allSites = Object.values(Game.constructionSites);
  if (allSites.length >= 100) return true; // globally maxed out
  const roomSites = allSites.filter(site => site.pos.roomName === room.name);
  // The maximum number of construction sites per player is 100. Don't spend them all in one room.
  if (roomSites.length >= 1 && roomSites.length >= 100 / Object.keys(Game.rooms).length) return true;
  for (const structureType of prioritizedStructureTypes) {
    if (!needStructure(room, structureType)) continue;
    const flag = getStructureFlags(room, structureType).find(
      f =>
        f.pos
          .look()
          .filter(
            content =>
              content.constructionSite?.structureType === structureType ||
              content.structure?.structureType === structureType
          ).length < 1 /* Planned position doesn't have the planned structure or construction site for it */
    );
    if (flag) {
      const outcome = flag.pos.createConstructionSite(structureType);
      if (outcome === OK) return false /* one/tick so that look() returns up-to-date data */;
      else if (outcome === ERR_INVALID_TARGET) flag.remove();
      else console.log("createConstructionSite() failed at", flag?.pos, outcome);
    }
  }
  return true;
}

function removeConstructionSitesWithoutFlags(room: Room) {
  const sitesToRemove = room
    .find(FIND_MY_CONSTRUCTION_SITES)
    .filter(
      site =>
        site.pos.lookFor(LOOK_FLAGS).filter(flag => flag.name.startsWith(site.structureType + "_")).length < 1
    );
  for (const site of sitesToRemove) site.remove();
  return true;
}

function destroyStructuresWithoutFlags(room: Room) {
  const spawnCount = Object.values(Game.spawns).filter(s => s.pos.roomName === room.name).length;
  const structuresToRemove = room
    .find(FIND_STRUCTURES)
    .filter(
      s => s.pos.lookFor(LOOK_FLAGS).filter(flag => flag.name.startsWith(s.structureType + "_")).length < 1
    );
  for (const structure of structuresToRemove) {
    if (structure.structureType === STRUCTURE_SPAWN) {
      if (spawnCount > 1) {
        structure.destroy(); // spawn
        return false;
      }
    } else {
      structure.destroy(); // not spawn
    }
  }
  return true;
}

export function getStructurePathCost(struct: AnyStructure | ConstructionSite): number | null {
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

export function getFreshCostMatrix(roomName: string): CostMatrix {
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
      const positions = getAccessiblePositionsAround(source.pos, 1, 1, true);
      for (const pos of positions) {
        if (costs.get(pos.x, pos.y) < 20) costs.set(pos.x, pos.y, 20);
      }
    });
  }
  return costs;
}

export function getFreshCostMatrixCreeps(roomName: string): CostMatrix {
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

export function isStorageSubstitute(container: AnyStructure | ConstructionSite): boolean {
  return (
    "structureType" in container &&
    container.structureType === STRUCTURE_CONTAINER &&
    container.pos.findInRange(FIND_MY_STRUCTURES, 3).filter(isController).length > 0 &&
    container.pos.findInRange(FIND_SOURCES, 1).length < 1
  );
}

export function getStorage(room: Room): StructureContainer | StructureStorage | undefined | null {
  return (
    room.storage ??
    room.controller?.pos.findInRange(FIND_STRUCTURES, 2).filter(isStorageSubstitute).filter(isContainer)[0]
  );
}

export function creepNameToEmoji(name: string): string {
  const initial = name.charAt(0);
  if (initial === "C") return "📦";
  if (initial === "E") return "🧭";
  if (initial === "H") return "⛏️";
  if (initial === "I") return "⚔️";
  if (initial === "R") return "🚩";
  if (initial === "T") return "↔️";
  if (initial === "U") return "⬆️";
  if (initial === "W") return "🛠️";
  return initial;
}

export function formatMilliseconds(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  return `${days}d${hours % 24}h${minutes % 60}m`;
}

export function getControllerText(room: Room): string | undefined {
  const controller = room.controller;
  if (!controller || !room.memory.controllerProgress || !room.memory.controllerProgressTime) return;
  const progressDelta = controller.progress - room.memory.controllerProgress;
  const msDelta = new Date().getTime() - room.memory.controllerProgressTime;
  const msPerProgress = msDelta / progressDelta;
  const progressRemaining = controller.progressTotal - controller.progress;
  return formatMilliseconds(msPerProgress * progressRemaining);
}
