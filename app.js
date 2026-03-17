'use strict';

const Homey = require('homey');

module.exports = class CanonApp extends Homey.App {

  /**
   * onInit is called when the app is initialized.
   */
  async onInit() {
    this.log('CanonApp has been initialized');
  }

};
