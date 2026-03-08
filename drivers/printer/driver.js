'use strict';

const Homey = require('homey');
const axios = require('axios');

module.exports = class PrinterDriver extends Homey.Driver {

  /**
   * onInit is called when the driver is initialized.
   */
  async onInit() {
    this.log('PrinterDriver has been initialized');
  }

  async onPair(session) {
    session.setHandler("ip", async (data) => {
      try {
        this.log('Checking IP address:', data.ip);
        const ip = data.ip;
        const response = await axios.get(`http://${ip}/JS_MDL/model.js`, { timeout: 5000 });
        return true;
      } catch (error) {
        this.error('Error during IP check:', error.message);
        return false;
      }
    });
  }

  /**
   * onPairListDevices is called when a user is adding a device
   * and the 'list_devices' view is called.
   * This should return an array with the data of devices that are available for pairing.
   */
  async onPairListDevices() {
    return [
      // Example device data, note that `store` is optional
      // {
      //   name: 'My Device',
      //   data: {
      //     id: 'my-device',
      //   },
      //   store: {
      //     address: '127.0.0.1',
      //   },
      // },
    ];
  }

};
