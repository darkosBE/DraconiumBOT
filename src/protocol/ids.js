'use strict';

const PKT = {
  LOGIN:                0x8f,
  PLAY_STATUS:          0x90,
  DISCONNECT:           0x91,
  BATCH:                0x92,
  TEXT:                 0x93,
  START_GAME:           0x95,
  ADD_PLAYER:           0x96,
  REMOVE_PLAYER:        0x97,
  MOVE_ENTITY:          0x9c,
  MOVE_PLAYER:          0x9d,
  UPDATE_ATTRIBUTES:    0xa6,
  SET_ENTITY_MOTION:    0xae,
  SET_HEALTH:           0xb0,
  SET_SPAWN_POSITION:   0xb1,
  ANIMATE:              0xb2,
  RESPAWN:              0xb3,
  ADVENTURE_SETTINGS:   0xbc,
  REQUEST_CHUNK_RADIUS: 0xc8,
  CHUNK_RADIUS_UPDATE:  0xc9,
};

const PLAY_STATUS = {
  LOGIN_SUCCESS:       0,
  LOGIN_FAILED_CLIENT: 1,
  LOGIN_FAILED_SERVER: 2,
  PLAYER_SPAWN:        3,
};

const MOVE_MODE = {
  NORMAL:   0,
  RESET:    1,
  TELEPORT: 2,
};

const TEXT_TYPE = {
  RAW:         0,
  CHAT:        1,
  TRANSLATION: 2,
  POPUP:       3,
  TIP:         4,
  SYSTEM:      5,
};

const PROTOCOL_VERSION = 70;

module.exports = { PKT, PLAY_STATUS, MOVE_MODE, TEXT_TYPE, PROTOCOL_VERSION };
