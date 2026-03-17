'use strict';

const Homey = require('homey');

module.exports = class CanonApp extends Homey.App {

  /**
   * onInit is called when the app is initialized.
   */
  async onInit() {
    this.log('CanonApp has been initialized');
  }

  async getLevels(deviceId) {
    const device = this.homey.devices.getDevice({ id: deviceId });
    if (!device) {
      throw new Error('Device not found');
    }
    return {
      levels: {
        BK: device.getCapabilityValue('measure_bk_level'),
        M: device.getCapabilityValue('measure_m_level'),
        C: device.getCapabilityValue('measure_c_level'),
        PGBK: device.getCapabilityValue('measure_pgbk_level'),
        Y: device.getCapabilityValue('measure_y_level'),
      },
      warnings: {
        BK: device.getCapabilityValue('measure_bk_level') <= 10,
        M: device.getCapabilityValue('measure_m_level') <= 10,
        C: device.getCapabilityValue('measure_c_level') <= 10,
        PGBK: device.getCapabilityValue('measure_pgbk_level') <= 10,
        Y: device.getCapabilityValue('measure_y_level') <= 10,
      },
    };
  }

};
