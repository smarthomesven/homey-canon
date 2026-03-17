'use strict';

const Homey = require('homey');
const axios = require('axios');
const INK_LEVEL_MAP = [100, 90, 80, 70, 60, 50, 40, 30, 20, 10, 0, null];
const INK_STATUS_MAP = ['ok', 'low', 'empty', 'unrecognized'];
const COLOR_MAP = { 0: 'BK', 1: 'PGBK', 2: 'C', 3: 'M', 4: 'Y' };
const M2_COLOR_MAP = { 0: 'M', 1: 'PGBK', 2: 'Y', 3: 'BK', 4: 'C' };
const INK_CAPABILITIES = [
  ['measure_bk_level', 'BK'],
  ['measure_m_level', 'M'],
  ['measure_c_level', 'C'],
  ['measure_pgbk_level', 'PGBK'],
  ['measure_y_level', 'Y'],
];
const INK_NAME_MAP = {
  InkBlk: 'BK',
  InkPbk: 'PGBK',
  InkCia: 'C',
  InkMaz: 'M',
  InkYel: 'Y',
  InkMbk: 'BK',
};
const http = require('http');

module.exports = class PrinterDevice extends Homey.Device {

  /**
   * onInit is called when the device is initialized.
   */
  async onInit() {
    this.log('PrinterDevice has been initialized');
    if (!this.getStoreValue('method')) {
      await this.setStoreValue('method', 1);
    }
    // migraties
    if (this.getStoreValue('method') === 2) {
      if (!this.getStoreValue('ink_level_migration_done')) {
        await this.addCapability('measure_bk_level');
        await this.addCapability('measure_m_level');
        await this.addCapability('measure_c_level');
        await this.addCapability('measure_pgbk_level');
        await this.addCapability('measure_y_level');
        await this.setStoreValue('has_ink_levels', true);
      }
    }
    if (this.getStoreValue('method') === 1) {
      this._interval = this.homey.setInterval(async () => {
        await this.pollPrinterStatus();
      }, 2 * 60 * 1000);
      await this.pollPrinterStatus();
    } else if (this.getStoreValue('method') === 2) {
      this._interval = this.homey.setInterval(async () => {
        await this.pollPrinterStatus2();
      }, 2 * 60 * 1000);
      await this.pollPrinterStatus2();
    }
  }

  async pollPrinterStatus() {
    try {
      const status = await this.getCanonPrinterStatus(this.getStoreValue('ip'));
      await this.applyPrinterStatus(status);
    } catch (error) {
      this.error('Error updating printer status:', error.message);
      await this.setUnavailable(this.homey.__('errors.unreachable'));
    }
  }

  async pollPrinterStatus2() {
    try {
      const status = await this.getCanonPrinterStatus2(this.getStoreValue('ip'));
      await this.applyPrinterStatus(status);
    } catch (error) {
      this.error('Error updating printer status:', error.message);
      this.log('Stack trace:', error.stack);
      await this.setUnavailable(this.homey.__('errors.unreachable'));
    }
  }

  async applyPrinterStatus(status) {
    await this.setAvailable();
    for (const [capabilityId, inkKey] of INK_CAPABILITIES) {
      await this.updateInkCapability(capabilityId, status.ink[inkKey]);
    }

    const signalStrength = this.getSignalStrengthValue(status);
    await this.updateCapabilityValue('measure_signal_strength', signalStrength);
  }

  async updateInkCapability(capabilityId, inkStatus) {
    const value = inkStatus ? inkStatus.levelPercent : null;
    await this.updateCapabilityValue(capabilityId, value);
  }

  async updateCapabilityValue(capabilityId, value) {
    if (!this.hasCapability(capabilityId)) {
      return;
    }

    await this.setCapabilityValue(capabilityId, value);
  }

  getSignalStrengthValue(status) {
    if (typeof status.signalStrength === 'number' && !Number.isNaN(status.signalStrength)) {
      return status.signalStrength;
    }

    if (typeof status.linkQuality === 'number' && !Number.isNaN(status.linkQuality)) {
      return status.linkQuality;
    }

    return null;
  }

  async getCanonPrinterStatus(printerIp) {
    try {
      const res = await axios.get(`http://${printerIp}/JS_MDL/model.js`);
      const js = await res.data;
      const inkLevels = this.parseInkLevels(js, COLOR_MAP);

      const signalMatch = js.match(/g_signal_strength\s*=\s*'(\d+)'/);
      const linkMatch   = js.match(/g_link_quality\s*=\s*'(\d+)'/);

      return {
        ink: inkLevels,
        signalStrength: signalMatch ? parseInt(signalMatch[1]) : null,
        linkQuality:    linkMatch   ? parseInt(linkMatch[1])   : null,
      };
    } catch (error) {
      throw new Error('Failed to fetch or parse printer status: ' + error.message);
    }
  }

  async getCanonPrinterStatus2(printerIp) {
    try {
      const agent = new http.Agent({ keepAlive: false });
      const ip = printerIp;
      if (!ip) {
        throw new Error('Printer IP address is not set');
      }
      const { data } = await axios.get(`http://${ip}/errindex.html`, { httpAgent: agent, timeout: 5000 });
      this.log('Fetched errindex.html');
      const res = await axios.get(`http://${ip}/js/model.js`, { httpAgent: agent, timeout: 5000 });
      this.log('Fetched js/model.js');
      const js = await res.data;
      const inkLevels = this.parseInkLevels(js, M2_COLOR_MAP);
      const match = data.match(/Signal Strength[\s\S]*?<td[^>]*>\s*(\d+%)\s*<\/td>/);
      if (!match) throw new Error('Signal Strength not found');
      const raw = match[1];
      const value = parseInt(raw);
      return {
        ink: inkLevels,
        signalStrength: value,
      };
    } catch (error) {
      throw new Error('Failed to fetch or parse printer status (method 2): ' + error.message);
    }
  }

  parseInkLevels(js, fallbackColorMap) {
    const inkLevels = {};
    const colorOrder = this.parseInkColorOrder(js);
    const inkRegex = /inktank\[\d+\]=\[(\d+),(\d+),(\d+)\];/g;
    let match;

    while ((match = inkRegex.exec(js)) !== null) {
      const [, colorId, levelIndex, statusIndex] = match.map(Number);
      const colorName = colorOrder[colorId] ?? fallbackColorMap[colorId] ?? `INK_${colorId}`;
      inkLevels[colorName] = {
        levelPercent: INK_LEVEL_MAP[levelIndex],
        status: INK_STATUS_MAP[statusIndex] ?? 'unknown',
      };
    }

    return inkLevels;
  }

  parseInkColorOrder(js) {
    const match = js.match(/var\s+inkCOL\s*=\s*\[([^\]]+)\];/i);
    if (!match) {
      return [];
    }

    return match[1]
      .split(',')
      .map((value) => value.trim().replace(/^['"]|['"]$/g, ''))
      .map((value) => INK_NAME_MAP[value] ?? value);
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
    if (this._interval) {
      this.homey.clearInterval(this._interval);
    }
  }

};
