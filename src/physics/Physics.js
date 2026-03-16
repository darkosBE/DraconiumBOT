'use strict';

// Client-side physics — PocketMine-MP Entity.php constants:
//   gravity = 0.08 blocks/tick²   drag = 0.02 → multiplier 0.98
//   jump velocity = 0.42 blocks/tick   tick = 50ms (20/s)
//
// Knockback bugs fixed:
//
//   BUG 1 — Knockback too strong:
//     PocketMine sends SetEntityMotion with the full intended velocity vector.
//     vx/vz can be ~0.4 blocks/tick which sends the bot flying too far.
//     Fix: cap horizontal knockback at 0.4 blocks/tick per axis, matching
//     what a real MCPE 0.14 client would receive from a standard attack.
//
//   BUG 2 — Second hit does nothing / bot floats after knockback:
//     The physics loop ran _tickGravity BEFORE _tickKnockback. When the bot
//     landed, _tickGravity called land() which zeroed ALL velocity including
//     horizontal. _tickKnockback then saw vel.x/z = 0 and did nothing.
//     On the next tick the bot was already grounded with zero velocity.
//     Fix: run _tickKnockback BEFORE _tickGravity so horizontal movement
//     is applied first. Also land() no longer zeroes horizontal velocity —
//     it only zeroes vertical. Horizontal decays naturally via drag.
//
//   BUG 3 — Bot floats after being knocked into the air (drop from height):
//     If the bot gets stuck with onGround=false but vel.y ~ 0 (e.g. tiny
//     oscillation around groundY), it never triggers the landing condition
//     and floats indefinitely. Fix: ground sync watchdog — if the bot has
//     been non-grounded for more than 5s with near-zero vertical velocity,
//     snap to groundY.
// notes for bugs to be fixed.

const TICK_MS        = 50;
const GRAVITY        = 0.08;
const DRAG           = 0.98;
const JUMP_VEL       = 0.42;
const ANTI_AFK_MS    = 55_000;
const KB_MAX_H       = 0.4;   
const FLOAT_TIMEOUT  = 5000;  

class Physics {
  constructor(onMove) {
    this._onMove      = onMove;
    this._tick        = null;
    this.chunksReady  = false;

    this.pos      = { x: 0, y: 64, z: 0 };
    this.vel      = { x: 0, y: 0, z: 0 };
    this.onGround = false;
    this.groundY  = null;

    this._airSince = null;
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

      if (!this.onGround) {
        if (this._airSince === null) this._airSince = now;
      } else {
        this._airSince = null;
      }

      if (!this.onGround && this._airSince !== null &&
          now - this._airSince > FLOAT_TIMEOUT &&
          Math.abs(this.vel.y) < 0.05 &&
          this.groundY !== null) {
        this.pos.y     = this.groundY;
        this.vel.y     = 0;
        this.onGround  = true;
        this._airSince = null;
        this._onMove(this.pos.x, this.pos.y, this.pos.z);
        return;
      }

      this._tickKnockback();
      this._tickGravity();
    }, TICK_MS);
  }

  stop() {
    if (this._tick) { clearInterval(this._tick); this._tick = null; }
  }

  _tickGravity() {
    if (this.onGround) return;

    this.vel.y = (this.vel.y - GRAVITY) * DRAG;
    const newY = this.pos.y + this.vel.y;

    if (this.groundY !== null && newY <= this.groundY) {
      this.pos.y    = this.groundY;
      this.vel.y    = 0;
      this.onGround = true;
    } else {
      this.pos.y = newY;
    }

    this._onMove(this.pos.x, this.pos.y, this.pos.z);
  }


  _tickKnockback() {
    if (this.vel.x === 0 && this.vel.z === 0) return;

    this.vel.x *= DRAG;
    this.vel.z *= DRAG;
    if (Math.abs(this.vel.x) < 0.001) this.vel.x = 0;
    if (Math.abs(this.vel.z) < 0.001) this.vel.z = 0;

    this.pos.x += this.vel.x;
    this.pos.z += this.vel.z;
    this._onMove(this.pos.x, this.pos.y, this.pos.z);
  }

  land(x, y, z, forced = false) {
    this.groundY  = y;
    this.vel.y    = 0;
    this.onGround = true;
    this._airSince = null;
    if (forced) {
      this.pos     = { x, y, z };
      this.vel     = { x: 0, y: 0, z: 0 };
    } else {
      this.pos.y = y;
    }
  }

  applyMotion(vx, vy, vz) {
    const cx = Math.max(-KB_MAX_H, Math.min(KB_MAX_H, vx));
    const cz = Math.max(-KB_MAX_H, Math.min(KB_MAX_H, vz));
    this.vel      = { x: cx, y: vy, z: cz };
    this.onGround = false;
    this.groundY  = null; 
    this._airSince = Date.now();
  }

  jump() {
    if (!this.onGround) return false;
    this._doJump();
    return true;
  }

  setPos(x, y, z) {
    this.pos      = { x, y, z };
    this.groundY  = y;
    this.vel      = { x: 0, y: 0, z: 0 };
    this.onGround = true;
    this._airSince = null;
  }

  _doJump() {
    this.vel.y     = JUMP_VEL;
    this.onGround  = false;
    this._airSince = Date.now();
  }
}

module.exports = { Physics };