'use strict';

const TICK_MS     = 50;
const GRAVITY     = 0.08;
const DRAG        = 0.98;
const JUMP_VEL    = 0.42;
const ANTI_AFK_MS = 55_000;
const KB_CAP      = 0.4;

class Physics {
  constructor(onMove) {
    this._onMove     = onMove;
    this._tick       = null;
    this.chunksReady = false;
    this.pos         = { x: 0, y: 64, z: 0 };
    this.vel         = { x: 0, y: 0,  z: 0 };
    this.onGround    = false;
    this.groundY     = null;
  }

  start() {
    if (this._tick) return;
    let lastAfk = Date.now();

    this._tick = setInterval(() => {
      if (!this.chunksReady) return;

      const now = Date.now();
      if (this.onGround && now - lastAfk >= ANTI_AFK_MS) {
        lastAfk = now;
        this._doJump();
      }

      this._tickKnockback();
      this._tickGravity();
      this._onMove(this.pos.x, this.pos.y, this.pos.z);
    }, TICK_MS);
  }

  stop() {
    if (this._tick) { clearInterval(this._tick); this._tick = null; }
  }

  _tickGravity() {
    if (this.onGround) {
      this.vel.y = 0;
      return;
    }

    this.vel.y = (this.vel.y - GRAVITY) * DRAG;

    const newY = this.pos.y + this.vel.y;

    // we know the floor — land when we reach it
    if (this.groundY !== null && newY <= this.groundY) {
      this.pos.y    = this.groundY;
      this.vel.y    = 0;
      this.onGround = true;
      return;
    }

    this.pos.y = newY;
  }

  _tickKnockback() {
    if (this.vel.x === 0 && this.vel.z === 0) return;
    this.vel.x *= DRAG;
    this.vel.z *= DRAG;
    if (Math.abs(this.vel.x) < 0.001) this.vel.x = 0;
    if (Math.abs(this.vel.z) < 0.001) this.vel.z = 0;
    this.pos.x += this.vel.x;
    this.pos.z += this.vel.z;
  }

  // server confirmed ground — this is the only source of truth for floor Y
  land(x, y, z, forced = false) {
    this.groundY  = y;
    this.vel.y    = 0;
    this.onGround = true;
    if (forced) {
      this.pos = { x, y, z };
      this.vel = { x: 0, y: 0, z: 0 };
    } else {
      this.pos.y = y;
    }
  }

  applyMotion(vx, vy, vz) {
    const cap     = v => Math.max(-KB_CAP, Math.min(KB_CAP, v));
    this.vel      = { x: cap(vx), y: vy, z: cap(vz) };
    this.onGround = false;
    // keep groundY — bot was just standing there, floor didn't move
    // server will send MovePlayer(onGround=true) when we land back on it
  }

  jump() {
    if (!this.onGround) return false;
    this._doJump();
    return true;
  }

  setPos(x, y, z) {
    this.pos      = { x, y, z };
    this.vel      = { x: 0, y: 0, z: 0 };
    this.onGround = false;
    this.groundY  = null;
  }

  _doJump() {
    this.vel.y    = JUMP_VEL;
    this.onGround = false;
  }
}

module.exports = { Physics };