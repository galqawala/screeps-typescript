import * as utils from "utils";

export function getBodyPartRatio(body: BodyPartConstant[], type: BodyPartConstant = MOVE): number {
  return body.filter(part => part === type).length / body.length;
}

export function getSpawn(
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

export function getNameForCreep(role: Role): string {
  const characters = "ABCDEFHJKLMNPRTUVWXYZ234789";
  let name = role.substring(0, 1).toUpperCase();
  while (Game.creeps[name]) {
    name += characters.charAt(Math.floor(Math.random() * characters.length));
  }
  return name;
}

export function getInitialCreepMem(task: Task | undefined, pos: RoomPosition): CreepMemory {
  return {
    destination: task?.destination && "id" in task?.destination ? task?.destination?.id : undefined,
    pos,
    stroke: utils.hslToHex(Math.random() * 360, 100, 50),
    strokeWidth: 0.1 + 0.1 * (Math.random() % 4)
  };
}

export function getBody(roleToSpawn: Role, energyAvailable: number): BodyPartConstant[] | undefined {
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

export function spawnCreep(
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

export function getHarvestPos(source: Source): RoomPosition {
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

export function downscaleHarvester(body: BodyPartConstant[]): BodyPartConstant[] | null {
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
      room.find(FIND_SOURCES).filter(harvestSource => !utils.sourceHasHarvester(harvestSource))
    );
  }
  if (sources.length < 1) return;
  const source = sources
    .map(value => ({ value, sort: value.energy + value.energyCapacity })) /* persist sort values */
    .sort((a, b) => b.sort - a.sort) /* sort */
    .map(({ value }) => value) /* remove sort values */[0];
  return source;
}

export function spawnHarvester(): boolean {
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

export function getTransferrerMem(
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
            (creep.ticksToLive || 100) > 30
        ).length <= 0
    );
}

export function spawnTransferer(): boolean {
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

export function spawnCreepForRoom(roleToSpawn: Role, targetPos: RoomPosition): boolean {
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

export function spawnReserver(): void {
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
