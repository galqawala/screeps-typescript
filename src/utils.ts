const minRoadTraffic = 0.016;

// Type guards
export function isOwnedStructure(structure: Structure): structure is AnyOwnedStructure {
  return (structure as { my?: boolean }).my !== undefined;
}
export function isStorage(
  structure: Structure | Ruin | Tombstone | Resource | EnergyStore
): structure is StructureStorage {
  if (!("structureType" in structure)) return false;
  return structure.structureType === STRUCTURE_STORAGE;
}
export function isDestructibleWall(structure: Structure): structure is StructureWall {
  return structure.structureType === STRUCTURE_WALL && "hits" in structure;
}
export function isLink(
  structure: Structure | Ruin | Tombstone | Resource | EnergyStore
): structure is StructureLink {
  if (!("structureType" in structure)) return false;
  return structure.structureType === STRUCTURE_LINK;
}
export function isTower(structure: Structure): structure is StructureTower {
  return structure.structureType === STRUCTURE_TOWER;
}
export function isSpawnOrExtension(
  structure: Structure | null | undefined | Destination
): structure is StructureSpawn | StructureExtension {
  if (!structure) return false;
  if (!("structureType" in structure)) return false;
  return structure.structureType === STRUCTURE_SPAWN || structure.structureType === STRUCTURE_EXTENSION;
}
export function isRoomPosition(item: RoomPosition): item is RoomPosition {
  return item instanceof RoomPosition;
}
export function isStoreStructure(
  item: Structure | undefined | Ruin | Tombstone | Resource
): item is AnyStoreStructure {
  if (!item) return false;
  return "store" in item;
}

export function isEmpty(object: Structure | Creep | Ruin | Resource | Tombstone): boolean {
  if (!object) return false;
  const store = getStore(object);
  if (!store) return false;
  return store.getUsedCapacity(RESOURCE_ENERGY) <= 0;
}

function getStore(object: Creep | AnyStructure | Resource | Ruin | Tombstone | Structure) {
  if ("store" in object) return object.store;
  if ("getUsedCapacity" in object) return object;
  return;
}

export function isFull(object: Structure | Creep | Ruin | Resource | Tombstone): boolean {
  if (!object) return false;
  const store = getStore(object);
  if (!store) return false;
  return store.getFreeCapacity(RESOURCE_ENERGY) <= 0;
}

export function getFillRatio(object: Structure | Creep): number {
  if (!object) return 0;
  const store = getStore(object);
  if (!store) return 0;
  return store.getUsedCapacity(RESOURCE_ENERGY) / store.getCapacity(RESOURCE_ENERGY);
}

export function getEnergy(object: Creep | AnyStructure | Resource | Ruin | Tombstone | Structure): number {
  if (!object) return 0;
  const store = getStore(object);
  if (store) return store.getUsedCapacity(RESOURCE_ENERGY);
  if ("energy" in object) return object.energy;
  return 0;
}

export function getFreeCap(object: Creep | AnyStructure | Resource | Ruin | Tombstone | Structure): number {
  if (!object) return Number.NEGATIVE_INFINITY;
  const store = getStore(object);
  if (store) return store.getFreeCapacity(RESOURCE_ENERGY);
  return Number.NEGATIVE_INFINITY;
}

export function getPos(obj: RoomPosition | RoomObject | null): RoomPosition | undefined {
  if (!obj) return;
  if (obj instanceof RoomPosition) return obj;
  if ("pos" in obj) return obj.pos;
  return;
}

export function getGlobalCoords(pos: RoomPosition): { x: number; y: number } {
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
  return Math.max(Math.abs(fromGlobal.x - toGlobal.x), Math.abs(fromGlobal.y - toGlobal.y));
}

export function cpuInfo(): void {
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
  const finalMsg = Game.time.toString() + " " + context.toString() + ": " + text;
  console.log(finalMsg);
  if (email) Game.notify(finalMsg);
}

export function getNameForCreep(role: Role): string {
  const characters = "ABCDEFHJKLMNPQRTUVWXYZ234789";
  let name = role.substring(0, 1).toUpperCase();
  while (Game.creeps[name]) {
    name += characters.charAt(Math.floor(Math.random() * characters.length));
  }
  return name;
}

export function updateStoreEnergy(
  roomName: string,
  id: Id<EnergySource | AnyStoreStructure>,
  amount: number
): void {
  const store = Memory.rooms[roomName].energyStores.filter(source => source.id === id)[0];
  if (amount > store.freeCap) amount = store.freeCap;
  if (amount < -store.energy) amount = -store.energy;
  store.energy += amount;
  store.freeCap -= amount;
}

export function shouldMaintainStatsFor(pos: RoomPosition): boolean {
  // to save CPU, gather stats for only part of the rooms and switch focus after certain interval
  const sections = 2;
  const interval = 10000;
  return pos.x % sections === Math.floor(Game.time / interval) % sections;
}

export function getTrafficFlagName(pos: RoomPosition): string {
  return "traffic_" + pos.roomName + "_" + pos.x.toString() + "_" + pos.y.toString();
}

export function getPositionsAround(origin: RoomPosition): RoomPosition[] {
  logCpu("getPositionsAround(" + origin.toString() + ")");
  const range = 1;
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

export function setUsername(): void {
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

export function logCpu(name: string): void {
  if (!(name in Memory.cpuLog)) {
    // cpuLog is not defined
    Memory.cpuLog[name] = { before: Game.cpu.getUsed(), after: Game.cpu.getUsed() };
  } else {
    Memory.cpuLog[name].after = Game.cpu.getUsed();
  }
}

export function blockedByStructure(pos: RoomPosition): boolean {
  return (
    pos
      .lookFor(LOOK_STRUCTURES)
      .filter(structure => (OBSTACLE_OBJECT_TYPES as StructureConstant[]).includes(structure.structureType))
      .length > 0
  );
}

export function containsPosition(list: RoomPosition[], pos: RoomPosition): boolean {
  return (
    list.filter(listPos => listPos.x === pos.x && listPos.y === pos.y && listPos.roomName === pos.roomName)
      .length > 0
  );
}

export function getControllersToReserve(): StructureController[] {
  logCpu("getControllersToReserve()");
  const controllers: StructureController[] = [];
  if (!Memory.plan.spawnHarvesters) return controllers;
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

export function creepsHaveDestination(structure: Structure): boolean {
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

export function shouldReserveRoom(room: Room): boolean {
  const controller = room.controller;
  if (room.memory.hostilesPresent) return false;
  if (!controller) return false;
  if (controller.owner) return false;
  if (isReservationOk(controller)) return false;
  if (isReservedByOthers(controller)) return false;
  return true;
}

export function isReservationOk(controller: StructureController): boolean {
  const reservation = controller.reservation;
  if (!reservation) return false;
  if (reservation.username !== Memory.username) return false;
  if (reservation.ticksToEnd < 2500) return false;
  return true;
}

export function isReservedByOthers(controller: StructureController): boolean {
  const reservation = controller.reservation;
  if (!reservation) return false;
  if (reservation.username !== Memory.username) return true;
  return false;
}

export function getCostOfCurrentCreepsInTheRole(role: Role): number {
  return (
    Object.values(Game.creeps).reduce(
      (aggregated, item) => aggregated + (item.memory.role === role ? getCreepCost(item) : 0),
      0 /* initial*/
    ) || 0
  );
}

export function getBodyForHarvester(source: Source): BodyPartConstant[] {
  const workParts = source.energyCapacity / ENERGY_REGEN_TIME / HARVEST_POWER;
  const body: BodyPartConstant[] = [CARRY];
  for (let x = 1; x <= workParts; x++) body.push(WORK);
  const moveParts = Math.ceil(body.length / 2); // 1:2 = 1/3 MOVE
  for (let x = 1; x <= moveParts; x++) body.push(MOVE);
  return body;
}

export function getBodyPartRatio(body: BodyPartConstant[], type: BodyPartConstant = MOVE): number {
  return body.filter(part => part === type).length / body.length;
}

export function spawnMsg(
  spawn: StructureSpawn,
  roleToSpawn: Role,
  name: string,
  body: BodyPartConstant[],
  target: string | undefined
): void {
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

export function getSpawnsAndExtensionsSorted(room: Room): (StructureSpawn | StructureExtension)[] {
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

export function constructContainerIfNeed(harvestPos: RoomPosition): void {
  if (
    harvestPos.lookFor(LOOK_STRUCTURES).filter(s => s.structureType !== STRUCTURE_ROAD).length <= 0 &&
    harvestPos.lookFor(LOOK_CONSTRUCTION_SITES).length <= 0 &&
    !hasStructureInRange(harvestPos, STRUCTURE_LINK, 1, true)
  ) {
    harvestPos.createConstructionSite(STRUCTURE_CONTAINER);
  }
}

export function getHarvestSpotForSource(source: Source): RoomPosition | undefined {
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

export function sourceHasHarvester(source: Source): boolean {
  for (const i in Game.creeps) {
    const creep = Game.creeps[i];
    if (creep.memory.sourceId === source.id) {
      return true;
    }
  }
  return false;
}

export function getCreepCost(creep: Creep): number {
  return getBodyCost(creep.body.map(part => part.type));
}

export function getTotalEnergyToHaul(): number {
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
    energy += Game.rooms[i]
      .find(FIND_RUINS)
      .reduce((aggregated, item) => aggregated + getEnergy(item), 0 /* initial*/);
  }
  return energy;
}

export function getTotalCreepCapacity(role: Role | undefined): number {
  return Object.values(Game.creeps).reduce(
    (aggregated, item) =>
      aggregated + (!role || item.memory.role === role ? item.store.getCapacity(RESOURCE_ENERGY) : 0),
    0 /* initial*/
  );
}

export function needRepair(structure: Structure): boolean {
  if (!structure) return false;
  if (isOwnedStructure(structure) && structure.my === false) return false;
  if (!structure.hits) return false;
  if (!structure.hitsMax) return false;
  if (structure.hits >= structure.hitsMax) return false;
  if (structure instanceof StructureRoad && getTrafficRateAt(structure.pos) < minRoadTraffic) return false;
  return true;
}

export function flagEnergyConsumer(pos: RoomPosition): void {
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

export function getConstructionSites(): ConstructionSite[] {
  let sites: ConstructionSite[] = [];
  for (const i in Game.rooms) {
    const room = Game.rooms[i];
    if (room.memory.hostilesPresent) continue;
    sites = sites.concat(
      room
        .find(FIND_MY_CONSTRUCTION_SITES)
        .filter(target => target.structureType !== STRUCTURE_CONTAINER /* leave for harvesters */)
    );
  }
  return sites;
}

export function isUnderRepair(structure: Structure): boolean {
  if (!structure) return false;
  if (!structure.id) return false;
  const creepsRepairingIt = Object.values(Game.creeps).filter(function (creep) {
    return creep.memory.action === "repair" && creep.memory.destination === structure.id;
  }).length;
  if (creepsRepairingIt) return true;
  return false;
}

export function tryResetSpawnsAndExtensionsSorting(room: Room): void {
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

export function canOperateInRoom(room: Room): boolean {
  if (!room.controller) return true; // no controller
  if (room.controller.my) return true; // my controller
  const reservation = room.controller.reservation;
  if (reservation && reservation.username === Memory.username) return true; // reserved to me
  if (!room.controller.owner && !reservation) return true; // no owner & no reservation
  return false;
}

export function getRoomStatus(roomName: string): "normal" | "closed" | "novice" | "respawn" {
  return Game.map.getRoomStatus(roomName).status;
}

export function isRoomSafe(roomName: string): boolean {
  if (!Memory.rooms[roomName]) return true;
  if (Memory.rooms[roomName].hostilesPresent) return false;
  return true;
}

export function getExit(
  pos: RoomPosition,
  safeOnly = true,
  harvestableOnly = true
): RoomPosition | null | undefined {
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

export function getPosForStorage(room: Room): RoomPosition | undefined {
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

export function getPlacesRequiringLink(room: Room): (StructureController | Source)[] {
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

export function getNearbyWorkSpotCount(pos: RoomPosition, upgradeSpots: boolean): number {
  const spots = upgradeSpots
    ? Memory.rooms[pos.roomName].upgradeSpots
    : Memory.rooms[pos.roomName].harvestSpots;
  let spotsAround = 0;
  spots.forEach(spot => {
    if (pos.getRangeTo(spot.x, spot.y) === 1) spotsAround++;
  });
  return spotsAround;
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

export function getPosForConstruction(
  room: Room,
  structureType: StructureConstant
): RoomPosition | undefined {
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
        finalScore /= getGlobalRange(pos, extensionPenalty.pos);
      }
    }

    if (bestScore < finalScore) {
      bestScore = finalScore;
      bestPos = pos;
    }
  }
  msg(room, "best score: " + (bestScore || "-").toString() + ", best pos: " + (bestPos || "-").toString());
  return bestPos;
}

export function getPosForRoad(room: Room): RoomPosition | undefined {
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

export function getTrafficRate(flag: Flag): number {
  if (!flag) return 0;
  if (!("initTime" in flag.memory)) return 0;
  if (flag.memory.initTime >= Game.time) return 0;
  return (flag.memory.steps || 0) / (Game.time - flag.memory.initTime);
}

export function getTrafficRateAt(pos: RoomPosition): number {
  return getTrafficRate(Game.flags[getTrafficFlagName(pos)]);
}

export function getPotentialConstructionSites(room: Room): ScoredPos[] {
  const sites: ScoredPos[] = [];

  for (let x = 2; x <= 47; x++) {
    for (let y = 2; y <= 47; y++) {
      if ((x + y) % 2 === 1) continue; // build in a checkered pattern to allow passage
      const pos = room.getPositionAt(x, y);
      if (!pos) continue;
      if (!isPosSuitableForConstruction(pos)) continue;
      const score =
        (hasStructureInRange(pos, STRUCTURE_ROAD, 1, true) ? 10 : 5) -
        pos.lookFor(LOOK_STRUCTURES).length +
        getSurroundingPlainsCount(pos);
      sites.push({ score, pos });
    }
  }
  return sites;
}

function getSurroundingPlainsCount(pos: RoomPosition) {
  let plains = 0;
  const positions = getPositionsAround(pos);
  const terrain = new Room.Terrain(pos.roomName);
  for (const posAround of positions) {
    if (terrain.get(posAround.x, posAround.y) === 0) plains++;
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
    if (isWorkerSpot(pos)) return false;
  }
  if (pos.findInRange(FIND_SOURCES, 2).length) return false;
  return true;
}

export function isWorkerSpot(pos: RoomPosition): boolean {
  const spots = Memory.rooms[pos.roomName].upgradeSpots.concat(Memory.rooms[pos.roomName].harvestSpots);
  for (const spot of spots) {
    if (pos.x === spot.x && pos.y === spot.y) return true;
  }
  return false;
}

export function getTarget(myUnit: StructureTower | Creep): Creep | PowerCreep | Structure | undefined {
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
  logCpu("setDestination(" + creep.name + ")");
  logCpu("setDestination(" + creep.name + ") update memory");
  if (destination && creep.memory.destination !== ("id" in destination ? destination.id : destination)) {
    if ("id" in destination) {
      creep.memory.destination = destination.id;
    } else if (destination instanceof RoomPosition) {
      creep.memory.destination = destination;
    }
  }
  logCpu("setDestination(" + creep.name + ") update memory");
  logCpu("setDestination(" + creep.name + ") set flag");
  if ("pos" in destination) setDestinationFlag(creep.name, destination.pos);
  else if (destination instanceof RoomPosition) setDestinationFlag(creep.name, destination);
  logCpu("setDestination(" + creep.name + ") set flag");
  logCpu("setDestination(" + creep.name + ")");
}

export function updateRoomRepairTargets(room: Room): void {
  logCpu("updateRoomRepairTargets(" + room.name + ")");
  const targets: Structure[] = room
    .find(FIND_STRUCTURES)
    .filter(target => needRepair(target) && (getHpRatio(target) || 1) < 0.9 && !isUnderRepair(target));
  room.memory.repairTargets = targets
    .map(target => target.id)
    .filter(
      id =>
        Object.values(Game.creeps).filter(
          creep => creep.memory.role === "worker" && creep.memory.destination === id
        ).length < 1
    );
  logCpu("updateRoomRepairTargets(" + room.name + ")");
}

export function getHpRatio(obj: Structure): number {
  if ("hits" in obj && "hitsMax" in obj) return obj.hits / obj.hitsMax;
  return 0;
}

export function updateRoomEnergyStores(room: Room): void {
  logCpu("updateRoomEnergyStores(" + room.name + ")");
  if (room.memory.hostilesPresent) {
    room.memory.energyStores = [];
    return;
  }
  let stores: (EnergySource | AnyStoreStructure)[] = room.find(FIND_DROPPED_RESOURCES);
  stores = stores.concat(room.find(FIND_TOMBSTONES));
  stores = stores.concat(room.find(FIND_RUINS));
  stores = stores.concat(room.find(FIND_STRUCTURES).filter(isStoreStructure));
  room.memory.energyStores = stores.map(store => {
    return {
      id: store.id,
      energy: getEnergy(store) + getStorePlannedEnergyChange(store.id),
      freeCap: getFreeCap(store) - getStorePlannedEnergyChange(store.id)
    } as EnergyStore;
  });
  logCpu("updateRoomEnergyStores(" + room.name + ")");
}

function getStorePlannedEnergyChange(id: Id<EnergySource | AnyStoreStructure>) {
  return Object.values(Game.creeps).reduce(
    (aggregated, item) =>
      aggregated +
      (item.memory.deliveryTasks
        ? item.memory.deliveryTasks.reduce(
            (total, task) => total + (task.destination === id ? -task.energy : 0),
            0 /* initial*/
          )
        : 0),
    0 /* initial*/
  );
}

export function constructInRoom(room: Room): void {
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

export function checkRoomStatus(room: Room): void {
  const value = getRoomStatus(room.name);
  if (room.memory.status !== value) {
    msg(room, "Status: " + room.memory.status + " ➤ " + value.toString(), true);
    room.memory.status = value;
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
  if (hostilesPresent) enableSafeModeIfNeed(room);
  logCpu("handleHostilesInRoom(" + room.name + ")");
}

export function enableSafeModeIfNeed(room: Room): void {
  const towerCount = room
    .find(FIND_MY_STRUCTURES)
    .filter(tower => tower.structureType === STRUCTURE_TOWER).length;
  if (towerCount <= 0) {
    if (room.controller && room.controller.activateSafeMode() === OK) {
      msg(room.controller, "safe mode activated!", true);
    }
  }
}

export function getHostileUsernames(hostileCreeps: Creep[], hostilePowerCreeps: PowerCreep[]): string[] {
  return hostileCreeps
    .map(creep => creep.owner.username)
    .concat(hostilePowerCreeps.map(creep => creep.owner.username))
    .filter((value, index, self) => self.indexOf(value) === index); // unique
}

export function updateUpgradeSpots(room: Room): void {
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

export function updateHarvestSpots(room: Room): void {
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

export function getLinkDownstreamPos(room: Room): RoomPosition | undefined {
  logCpu("getLinkDownstreamPos(" + room.name + ")");
  const flagName = room.name + "_EnergyConsumer";
  if (!(flagName in Game.flags)) return;
  const flag = Game.flags[flagName];
  const destination = flag.pos;
  if (getCreepCountByRole("worker", 0) < 1) {
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

export function handleLinks(room: Room): void {
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
    }
  }
  logCpu("handleLinks(" + room.name + ") loop");
  logCpu("handleLinks(" + room.name + ")");
}

export function getSortedLinks(room: Room, downstreamPos: RoomPosition): StructureLink[] {
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

export function getTargetCreep(myUnit: StructureTower | Creep): ScoredTarget | undefined {
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

export function getTargetPowerCreep(myUnit: StructureTower | Creep): ScoredTarget | undefined {
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

export function getTargetStructure(myUnit: StructureTower | Creep): ScoredTarget | undefined {
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

export function engageTarget(myUnit: StructureTower | Creep, target: Structure | Creep | PowerCreep): number {
  if (isEnemy(target) || target instanceof StructureWall) {
    return myUnit.attack(target);
  } else if (target instanceof Creep || target instanceof PowerCreep) {
    return myUnit.heal(target);
  } else {
    return myUnit.repair(target);
  }
}

export function isEnemy(object: Structure | Creep | PowerCreep): boolean {
  if (object instanceof Creep || object instanceof PowerCreep) return object.my === false;
  return isOwnedStructure(object) && object.my === false;
}

export function shouldHarvestRoom(room: Room): boolean {
  if (!room) return false;
  if (room.controller?.my) return true;
  const exits = Game.map.describeExits(room.name);
  return (
    Object.values(exits).filter(roomName => Game.rooms[roomName] && Game.rooms[roomName].controller?.my)
      .length > 0
  );
}

export function getCreepCountByRole(role: Role, minTicksToLive = 120): number {
  return Object.values(Game.creeps).filter(function (creep) {
    return creep.memory.role === role && (!creep.ticksToLive || creep.ticksToLive >= minTicksToLive);
  }).length;
}

export function getBodyCost(body: BodyPartConstant[]): number {
  return body.reduce(function (cost, part) {
    return cost + BODYPART_COST[part];
  }, 0);
}
export function construct(room: Room, structureType: BuildableStructureConstant): void {
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

export function resetSpecificDestinationFromCreeps(destination: Destination): void {
  for (const i in Game.creeps) {
    const creep = Game.creeps[i];
    if (creep.memory.destination && "id" in destination && creep.memory.destination === destination.id) {
      resetDestination(creep);
    }
  }
}

export function resetDestination(creep: Creep): void {
  logCpu("resetDestination(" + creep.name + ")");
  if (creep?.memory?.deliveryTasks && creep?.memory?.deliveryTasks?.length >= 1)
    creep?.memory?.deliveryTasks?.shift();
  creep.memory.destination = undefined;
  creep.memory.action = undefined;
  const flag = Game.flags["creep_" + creep.name];
  if (flag) flag.remove();
  logCpu("resetDestination(" + creep.name + ")");
  return;
}

export function getOwnedRoomsCount(): number {
  return Object.values(Game.rooms).filter(room => room.controller?.my).length;
}

export function getUpgradeableControllerCount(): number {
  return Object.values(Game.rooms).filter(
    room => room.controller?.my && (room.controller?.level < 8 || room.controller?.ticksToDowngrade < 100000)
  ).length;
}

export function updateRemoteHarvestCost(room: Room): void {
  let cost = 0;
  if (room.controller?.my) {
    cost = 1;
  } else {
    const sources = room.find(FIND_SOURCES);
    for (const source of sources) {
      const storages = Object.values(Game.structures).filter(isStorage);
      const path = PathFinder.search(
        source.pos,
        storages.map(storage => storage.pos)
      );
      cost += path.incomplete ? 1000 : path.cost;
    }
    if (sources.length > 0) cost /= sources.length;
  }
  room.memory.remoteHarvestCost = cost;
}

export function getTotalRepairTargetCount(): number {
  return Object.values(Game.rooms).reduce(
    (aggregated, item) => aggregated + (item.memory.repairTargets?.length || 0),
    0 /* initial*/
  );
}
