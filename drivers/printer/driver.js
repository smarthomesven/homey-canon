'use strict';

const Homey = require('homey');
const { detectCanonPrinter, discoverCanonPrinters } = require('../../lib/canon-printer');

module.exports = class PrinterDriver extends Homey.Driver {

  /**
   * onInit is called when the driver is initialized.
   */
  async onInit() {
    this.log('PrinterDriver has been initialized');
  }

  async onPair(session) {
    session.setHandler('discover', async () => {
      const printers = await discoverCanonPrinters();
      this.log(`Discovered ${printers.length} Canon printer(s) on the local network`);
      return printers;
    });

    session.setHandler("ip", async (data) => {
      const ip = data.ip;
      try {
        this.log('Checking IP address:', data.ip);
        const printer = await detectCanonPrinter(ip, { timeout: 5000 });
        return {
          success: true,
          method: printer.method,
          capabilities: printer.capabilities,
          capabilitiesOptions: printer.capabilitiesOptions,
        };
      } catch (error) {
        this.error('Error during IP check:', error.message);
        return { success: false };
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
