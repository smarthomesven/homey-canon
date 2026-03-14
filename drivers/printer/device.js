'use strict';

const Homey = require('homey');
const axios = require('axios');
const INK_LEVEL_MAP = [100, 90, 80, 70, 60, 50, 40, 30, 20, 10, 0, null];
const INK_STATUS_MAP = ['ok', 'low', 'empty', 'unrecognized'];
const COLOR_MAP = { 0: 'BK', 1: 'PGBK', 2: 'C', 3: 'M', 4: 'Y' };

module.exports = class PrinterDevice extends Homey.Device {

  /**
   * onInit is called when the device is initialized.
   */
  async onInit() {
    this.log('PrinterDevice has been initialized');
    this._interval = this.homey.setInterval(async () => {
      await this.pollPrinterStatus();
    }, 2 * 60 * 1000);
    await this.pollPrinterStatus();
  }

  async pollPrinterStatus() {
    try {
      const status = await this.getCanonPrinterStatus(this.getStoreValue('ip'));
      this.setAvailable();
      this.setCapabilityValue('measure_bk_level', status.ink.BK.levelPercent);
      this.setCapabilityValue('measure_m_level', status.ink.M.levelPercent);
      this.setCapabilityValue('measure_c_level', status.ink.C.levelPercent);
      this.setCapabilityValue('measure_pgbk_level', status.ink.PGBK.levelPercent);
      this.setCapabilityValue('measure_y_level', status.ink.Y.levelPercent);
      this.setCapabilityValue('measure_signal_strength', status.signalStrength);
    } catch (error) {
      this.error('Error updating printer status:', error.message);
      this.setUnavailable(this.homey.__('errors.unreachable'));
    }
}

  async getCanonPrinterStatus(printerIp) {
    const res = await axios.get(`http://${printerIp}/JS_MDL/model.js`);
    const js = await res.data;

    const inkLevels = {};
    const inkRegex = /inktank\[\d+\]=\[(\d+),(\d+),(\d+)\];/g;
    let match;
    while ((match = inkRegex.exec(js)) !== null) {
      const [, colorId, levelIndex, statusIndex] = match.map(Number);
      const colorName = COLOR_MAP[colorId] ?? `INK_${colorId}`;
      inkLevels[colorName] = {
        levelPercent: INK_LEVEL_MAP[levelIndex],  // null if unknown
        status: INK_STATUS_MAP[statusIndex] ?? 'unknown',
      };
    }

    const signalMatch = js.match(/g_signal_strength\s*=\s*'(\d+)'/);
    const linkMatch   = js.match(/g_link_quality\s*=\s*'(\d+)'/);

    return {
      ink: inkLevels,
      signalStrength: signalMatch ? parseInt(signalMatch[1]) : null,
      linkQuality:    linkMatch   ? parseInt(linkMatch[1])   : null,
    };
  }

  /**
   * onAdded is called when the user adds the device, called just after pairing.
   */
  async onAdded() {
    this.log('PrinterDevice has been added');
  }

  /**
   * onSettings is called when the user updates the device's settings.
   * @param {object} event the onSettings event data
   * @param {object} event.oldSettings The old settings object
   * @param {object} event.newSettings The new settings object
   * @param {string[]} event.changedKeys An array of keys changed since the previous version
   * @returns {Promise<string|void>} return a custom message that will be displayed
   */
  async onSettings({ oldSettings, newSettings, changedKeys }) {
    this.log('PrinterDevice settings where changed');
  }

  /**
   * onRenamed is called when the user updates the device's name.
   * This method can be used this to synchronise the name to the device.
   * @param {string} name The new name
   */
  async onRenamed(name) {
    this.log('PrinterDevice was renamed');
  }

  /**
   * onDeleted is called when the user deleted the device.
   */
  async onDeleted() {
    this.log('PrinterDevice has been deleted');
  }

};
