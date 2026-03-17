'use strict';

module.exports = {
  async getLevels({ homey, body }) {
    return await homey.app.getLevels(body.device);
  },
};
