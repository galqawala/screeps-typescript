import * as utils from "utils";

function getBodyPartRatio(body: BodyPartConstant[], type: BodyPartConstant = MOVE): number {
  return body.filter(part => part === type).length / body.length;
}

function getSpawn(
  energyRequired: number,
  targetPos: RoomPosition | undefined,
  maxRange = 100
): StructureSpawn {
  return Object.values(Game.spawns)
    .filter(spawn => spawn.room.energyAvailable >= energyRequired && !spawn.spawning)
    .filter(s => !targetPos || s.pos.roomName === targetPos?.roomName || utils.isRoomSafe(s.pos.roomName))
    .map(spawn => ({
      spawn,
      range: targetPos ? utils.getGlobalRange(spawn.pos, targetPos) : 0
    })) /* persist sort values */
    .filter(spawnRange => spawnRange.range <= maxRange)
    .sort((a, b) => a.range - b.range) /* sort */
    .map(({ spawn }) => spawn) /* remove sort values */[0];
}

function getNameForCreep(role: Role): string {
  const characters = "ABCDEFHJKLMNPRTUVWXYZ234789";
  let name = role.substring(0, 1).toUpperCase();
  while (Game.creeps[name]) {
    name += characters.charAt(Math.floor(Math.random() * characters.length));
  }
  return name;
}

function getInitialCreepMem(task: Task | undefined, pos: RoomPosition): CreepMemory {
  return {
    destination: task?.destination && "id" in task?.destination ? task?.destination?.id : undefined,
    pos,
    stroke: utils.hslToHex(Math.random() * 360, 100, 50),
    strokeWidth: 0.1 + 0.1 * (Math.random() % 4)
  };
}

function getBody(roleToSpawn: Role, energyAvailable: number): BodyPartConstant[] | undefined {
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
    if (getBodyPartRatio(body, MOVE) <= 0.2) nextPart = MOVE;
    else if (getBodyPartRatio(body, CARRY) <= 0.1) nextPart = CARRY;

    if (utils.getBodyCost(body) + BODYPART_COST[nextPart] > energyAvailable) return body;
    body.push(nextPart);
    if (body.length >= 50) return body;
  }
}

function getBodyForWorker(energyAvailable: number) {
  const body: BodyPartConstant[] = [WORK, CARRY, MOVE];
  for (;;) {
    let nextPart: BodyPartConstant = WORK;
    if (getBodyPartRatio(body, MOVE) <= 0.34) nextPart = MOVE;
    else if (getBodyPartRatio(body, CARRY) <= 0.4) nextPart = CARRY;

    if (utils.getBodyCost(body) + BODYPART_COST[nextPart] > energyAvailable) return body;
    body.push(nextPart);
    if (body.length >= 50) return body;
  }
}

function getBodyForCarrier(energyAvailable: number) {
  const body: BodyPartConstant[] = [CARRY, MOVE];
  for (;;) {
    const nextPart = getBodyPartRatio(body) <= 0.34 ? MOVE : CARRY;
    if (utils.getBodyCost(body) + BODYPART_COST[nextPart] > energyAvailable) return body;
    body.push(nextPart);
    if (body.length >= 50) return body;
  }
}

function getBodyForReserver(energyAvailable: number) {
  const body: BodyPartConstant[] = [CLAIM, MOVE];
  for (;;) {
    const nextPart = getBodyPartRatio(body) <= 0.34 ? MOVE : CLAIM;
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

function spawnCreep(
  roleToSpawn: Role,
  energyRequired?: number,
  body: undefined | BodyPartConstant[] = undefined,
  task: Task | undefined = undefined,
  spawn: StructureSpawn | undefined = undefined,
  memory: CreepMemory | undefined = undefined
): boolean {
  if (!energyRequired && body) energyRequired = utils.getBodyCost(body);
  if (!energyRequired || energyRequired < 50) return false;
  if (!body) body = getBody(roleToSpawn, energyRequired);
  const name = getNameForCreep(roleToSpawn);
  if (!spawn) spawn = getSpawn(energyRequired, utils.getPos(task?.destination));
  if (!spawn) return false;
  if (spawn.spawning) return false;
  if (!body || utils.getBodyCost(body) > spawn.room.energyAvailable || !body.includes(MOVE)) return false;

  const outcome = spawn.spawnCreep(body, name, {
    memory: memory ?? getInitialCreepMem(task, spawn.pos)
  });

  if (outcome === OK) {
    return true;
  } else {
    utils.msg(spawn, "Failed to spawn creep: " + outcome.toString() + " with body " + body.toString());
    console.log("body", body, "energyAvailable", energyRequired);
    return false;
  }
}

function getHarvestPos(source: Source): RoomPosition {
  const positions = utils.getPositionsAroundWithTerrainSpace(source.pos, 1, 1, 1, 1);
  return (
    positions.find(
      /* container here*/
      pos => pos.lookFor(LOOK_FLAGS).filter(f => f.name.startsWith(STRUCTURE_CONTAINER + "_")).length > 0
    ) ??
    positions.find(
      /* next to link*/
      pos => pos.findInRange(FIND_FLAGS, 1).filter(f => f.name.startsWith(STRUCTURE_LINK + "_")).length > 0
    ) ??
    positions[0] /* space around*/
  );
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

export function getSourceToHarvest(): Source | undefined {
  let sources: Source[] = [];
  for (const roomName in Game.rooms) {
    const room = Game.rooms[roomName];
    if (!utils.isRoomSafe(roomName)) continue;
    if (!utils.canOperateInRoom(room)) continue;
    if (!utils.shouldHarvestRoom(room)) continue;
    sources = sources.concat(
      room.find(FIND_SOURCES).filter(harvestSource => !sourceHasHarvester(harvestSource))
    );
  }
  if (sources.length < 1) return;
  const source = sources
    .map(value => ({ value, sort: value.energy + value.energyCapacity })) /* persist sort values */
    .sort((a, b) => b.sort - a.sort) /* sort */
    .map(({ value }) => value) /* remove sort values */[0];
  return source;
}

function spawnHarvester(): boolean {
  const roleToSpawn: Role = "harvester";
  const source = getSourceToHarvest();
  if (!source || !(source instanceof Source)) return false;
  let body: BodyPartConstant[] | null = getBodyForHarvester(source);
  let cost = utils.getBodyCost(body);
  let spawn = getSpawn(cost, source.pos);
  while (!spawn && body) {
    body = downscaleHarvester(body);
    if (!body) return false;
    cost = utils.getBodyCost(body);
    spawn = getSpawn(cost, source.pos);
  }
  if (!spawn || !body) return false;
  const name = getNameForCreep(roleToSpawn);
  const harvestPos = getHarvestPos(source);
  if (!harvestPos) return false;
  const memory = {
    sourceId: source.id,
    stroke: utils.hslToHex(Math.random() * 360, 100, 50),
    strokeWidth: 0.1 + 0.1 * (Math.random() % 4),
    pos: spawn.pos
  };
  if (spawn.spawnCreep(body, name, { memory }) === OK) {
    utils.setDestinationFlag(name, harvestPos);
    return true;
  }
  return false;
}

function getBodyForHarvester(source: Source): BodyPartConstant[] {
  const workParts = source.energyCapacity / ENERGY_REGEN_TIME / HARVEST_POWER;
  const body: BodyPartConstant[] = [CARRY];
  for (let x = 1; x <= workParts; x++) body.push(WORK);
  const moveParts = Math.ceil(body.length / 2); // 1:2 = 1/3 MOVE
  for (let x = 1; x <= moveParts; x++) body.push(MOVE);
  return body;
}

function getTransferrerMem(
  retrieve: Id<StructureLink>,
  transferTo: Id<StructureStorage>,
  pos: RoomPosition
): CreepMemory {
  return {
    retrieve,
    transferTo,
    stroke: utils.hslToHex(Math.random() * 360, 100, 50),
    strokeWidth: 0.1 + 0.1 * (Math.random() % 4),
    pos
  };
}

export function getStoragesRequiringTransferer(): StructureStorage[] {
  return Object.values(Game.structures)
    .filter(utils.isStorage)
    .filter(
      storage =>
        utils.hasStructureInRange(storage.pos, STRUCTURE_LINK, 2, false) &&
        Object.values(Game.creeps).filter(
          creep =>
            creep.name.startsWith("T") &&
            creep.memory.transferTo === storage.id &&
            (creep.ticksToLive ?? CREEP_LIFE_TIME) > getTimeToReplace(creep)
        ).length <= 0
    );
}

function spawnTransferer(): boolean {
  const roleToSpawn: Role = "transferer";
  const storages = getStoragesRequiringTransferer();
  if (storages.length < 1) return false;
  const tgtStorage = storages[0];
  const link = tgtStorage.pos.findClosestByRange(FIND_MY_STRUCTURES, {
    filter: { structureType: STRUCTURE_LINK }
  });
  if (!link || !utils.isLink(link)) return false;
  const body: BodyPartConstant[] = [CARRY, CARRY, CARRY, MOVE];
  const cost = utils.getBodyCost(body);
  const spawn = getSpawn(cost, tgtStorage.pos);
  if (!spawn) return false;
  const name = getNameForCreep(roleToSpawn);
  return (
    spawn.spawnCreep(body, name, {
      memory: getTransferrerMem(link.id, tgtStorage.id, spawn.pos)
    }) === OK
  );
}

function spawnCreepForRoom(roleToSpawn: Role, targetPos: RoomPosition): boolean {
  const spawn = getSpawn(0, targetPos);
  if (!spawn) return false;

  const memory = {
    pos: spawn.pos,
    stroke: utils.hslToHex(Math.random() * 360, 100, 50),
    strokeWidth: 0.1 + 0.1 * (Math.random() % 4),
    room: targetPos.roomName
  };
  return spawnCreep(roleToSpawn, spawn.room.energyAvailable, undefined, undefined, spawn, memory);
}

function spawnReserver(): void {
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

function needExplorers(): boolean {
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

export function spawnCreeps(): void {
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

function spawnOneCarrier(room: Room): void {
  const controller = room.controller;
  if (!controller || !controller.my) return;
  const carriers = Object.values(Game.creeps).filter(
    creep => creep.name.startsWith("C") && creep.memory.room === room.name
  );
  if (carriers.length > 0) return;
  const containersWithEnergy = room
    .find(FIND_STRUCTURES)
    .filter(utils.isContainer)
    .filter(container => utils.getEnergy(container) > 0 && !utils.isStorageSubstitute(container)).length;
  const storage = utils.getStorage(room);
  const energyStored = storage && utils.getEnergy(storage) > 0;
  const spawnsLacking = room.energyAvailable < room.energyCapacityAvailable;
  if (
    (containersWithEnergy > 0 || (energyStored && spawnsLacking)) &&
    (carriers.length < 1 || utils.gotSpareCpu())
  )
    spawnCreepForRoom("carrier", controller.pos);
}

function spawnExtraCarriers(room: Room): void {
  const controller = room.controller;
  if (!controller || !controller.my) return;
  const freshCarriers = Object.values(Game.creeps).filter(
    creep =>
      creep.name.startsWith("C") &&
      creep.memory.room === room.name &&
      (creep.spawning ||
        (creep.memory.lastTimeFull ?? 0) < Game.time - 100 ||
        (creep.ticksToLive ?? CREEP_LIFE_TIME) > CREEP_LIFE_TIME * 0.9)
  );
  if (freshCarriers.length > 0) return;
  const fullContainers = roomHasFullContainers(room) || roomHasFullRemoteContainers(room.name);
  const storage = utils.getStorage(room);
  const energyStored = storage && utils.getEnergy(storage) > 0;
  const spawnsBeenLacking = (room.memory.lackedEnergySinceTime ?? 0) < Game.time - 100;
  if ((fullContainers || (energyStored && spawnsBeenLacking)) && utils.gotSpareCpu())
    spawnCreepForRoom("carrier", controller.pos);
}

function roomHasFullRemoteContainers(ownedRoomName: string) {
  const remoteHarvestRoomNames = Object.values(Game.map.describeExits(ownedRoomName)).filter(exitRoomName =>
    utils.isRoomReservationOk(exitRoomName)
  );
  for (const remoteHarvestRoomName of remoteHarvestRoomNames)
    if (roomHasFullContainers(Game.rooms[remoteHarvestRoomName])) return true;
  return false;
}

function roomHasFullContainers(room: Room) {
  return (
    room
      .find(FIND_STRUCTURES)
      .filter(utils.isContainer)
      .filter(container => utils.isFull(container) && !utils.isStorageSubstitute(container)).length > 0
  );
}

function spawnByQuota(room: Room, role: Role, max: number): void {
  const controller = room.controller;
  if (!controller) return;
  const count = Object.values(Game.creeps).filter(
    creep => creep.name.startsWith(role.charAt(0).toUpperCase()) && creep.memory.room === room.name
  ).length;
  if (count < max) spawnCreepForRoom(role, controller.pos);
}

function spawnWorkerIfWorkAvailable(room: Room, max: number): void {
  const role = "worker";
  const controller = room.controller;
  if (!controller) return;
  const count = Object.values(Game.creeps).filter(
    creep => creep.name.startsWith(role.charAt(0).toUpperCase()) && creep.memory.room === room.name
  ).length;
  if (count >= max) return;
  const gotWork =
    room.find(FIND_MY_CONSTRUCTION_SITES).length > 0 ||
    room.find(FIND_STRUCTURES).filter(s => s.hits < s.hitsMax / 2).length > 0;
  if (!gotWork) return;
  spawnCreepForRoom(role, controller.pos);
}

function spawnCreepWhenStorageFull(room: Room): void {
  const controller = room.controller;
  if (!controller || !controller.my) return;
  if (room.energyAvailable < room.energyCapacityAvailable) return;
  const storage = utils.getStorage(room);
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

export function spawnCreepsInRoom(room: Room): void {
  if (room.controller?.my && utils.canOperateInRoom(room)) {
    // owned room
    spawnOneCarrier(room);
    spawnExtraCarriers(room);
    spawnByQuota(room, "worker", 1);
    spawnByQuota(room, "upgrader", 1);
    spawnCreepWhenStorageFull(room);
  } else if (utils.isRoomReservationOk(room.name)) {
    // reserved room
    spawnWorkerIfWorkAvailable(room, 1);
  }
}

function sourceHasHarvester(source: Source): boolean {
  for (const creep of Object.values(Game.creeps)) {
    if (!creep.memory.sourceId || creep.memory.sourceId !== source.id) continue;
    if ((creep.ticksToLive ?? CREEP_LIFE_TIME) > getTimeToReplace(creep)) return true;
  }
  return false;
}

function getTimeToReplace(creep: Creep) {
  return Math.max(0, (creep.memory.workStartTime ?? 0) - (creep.memory.spawnStartTime ?? 0));
}

export function needReservers(): boolean {
  return (
    (Memory.plan?.controllersToReserve?.length ?? 0) > 0 ||
    ("claim" in Game.flags && utils.getCreepCountByRole("reserver") < 1)
  );
}

export function needInfantry(): boolean {
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
