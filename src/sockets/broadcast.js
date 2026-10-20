// Thin bridge so services can notify clients without importing socket code.
let io = null;
export const setIo = (x) => { io = x; };
export const getIo = () => io;
export const toGame = (roomId, evt, payload) => io?.to(`game:${roomId}`).emit(evt, payload);
export const toHostCtl = (roomId, evt, payload) => io?.to(`hostctl:${roomId}`).emit(evt, payload);
export const toPlayer = (playerId, evt, payload) => io?.to(`player:${playerId}`).emit(evt, payload);
