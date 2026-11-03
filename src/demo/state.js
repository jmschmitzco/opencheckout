// What the demo seeded, so the demo routes can find it.
//
// It exists because of an ordering constraint: app.js registers a catch-all
// 404 last, so anything mounted onto the finished app never runs. The demo
// routes therefore have to be mounted BY app.js, which means they cannot be
// handed the seed data as an argument. They read it from here instead, and the
// demo server fills it in before requiring the app.
let state = null;

function setDemoState(value) {
  state = value;
}

function getDemoState() {
  return state;
}

module.exports = { setDemoState, getDemoState };
