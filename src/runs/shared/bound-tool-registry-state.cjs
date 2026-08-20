"use strict";
let state;
module.exports = {
  get state() { return state; },
  set state(value) { state = value; },
};
