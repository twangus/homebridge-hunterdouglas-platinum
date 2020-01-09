'use strict'

const Bridge = require('./lib/Bridge')

let Accessory, Service, Characteristic, uuid
let BlindAccessory

module.exports = function(homebridge) {
  Accessory = homebridge.hap.Accessory
  Service = homebridge.hap.Service
  Characteristic = homebridge.hap.Characteristic
  uuid = homebridge.hap.uuid

  // eslint-disable-next-line no-unused-vars
  const exportedTypes = {
    Accessory: Accessory,
    Service: Service,
    Characteristic: Characteristic,
    uuid: uuid
  }

  BlindAccessory = require('./lib/BlindAccessory')(exportedTypes)

  homebridge.registerPlatform(
    'homebridge-hunterdouglas-platinum',
    'HunterDouglasPlatinum',
    HunterDouglasPlatinumPlatform
  )
}

const DEFAULT_STATUS_POLLING_SECONDS = 60

class HunterDouglasPlatinumPlatform {
  constructor(log, config) {
    this.log = log
    this.config = config
    this.blindAccessories = new Map()
    this.pendingRefreshPromise = null
    this.blindController = new Bridge.Controller(config)
  }

  /** Homebridge requirement that will fetch all the discovered accessories */
  accessories(callback) {
    this.log.info('Fetching Blind Info...')

    this._accessories()
      .then(foundAccessories => {
        this.log.info('found', foundAccessories.length, 'accessories')
        callback(foundAccessories)
      })
      .catch(err => {
        this.log.error('unable to get blind config:', err)
        callback([])
      })
  }

  async _accessories() {
    this.blindConfig = await this.blindController.getConfig()

    this.device_id = this.blindConfig.serialNumber

    this.log.info(
      'connected:',
      this.blindConfig.serialNumber,
      this.blindConfig.softwareVersion,
      '(getBlindConfig)'
    )

    var accessories = []

    for (const [_shadeId, shade] of this.blindConfig.shades) {
      //const room = this.blindConfig.rooms.get(shade.roomId)
      //const name = room.name + ' ' + shade.name
      const name = shade.name

      const blind = new BlindAccessory(name, shade.id, shade.roomId, this)
      this.blindAccessories.set(shade.id, blind)
      accessories.push(blind)
    }

    // start polling for status
    this._pollForStatus(0)

    return accessories
  }

  /** start polling process with truncated exponential backoff: https://cloud.google.com/storage/docs/exponential-backoff */
  _pollForStatus(retryAttempt) {
    let backoff = function(retryAttempt, maxTime) {
      retryAttempt = Math.max(retryAttempt, 1)
      return Math.min(Math.pow(retryAttempt - 1, 2) + Math.random(), maxTime)
    }

    const pollingInterval = this.config.statusPollingSeconds || DEFAULT_STATUS_POLLING_SECONDS

    this._refreshAccessoryValues()
      .then(() => {
        // on success, start another timeout at normal pollingInterval
        this.log.debug('_pollForStatus success, retryAttempt:', retryAttempt)
        setTimeout(() => this._pollForStatus(0), pollingInterval * 1000)
      })
      .catch(err => {
        // on error, start another timeout with backoff
        const timeout = pollingInterval + backoff(retryAttempt, pollingInterval * 20)
        this.log.error('_pollForStatus retryAttempt:', retryAttempt, 'timeout:', timeout, err)
        setTimeout(() => this._pollForStatus(retryAttempt + 1), timeout * 1000)
      })
  }

  // refresh all accessories
  async _refreshAccessoryValues() {
    // if there already is a pending promise, just return it
    if (this.pendingRefreshPromise) {
      this.log.debug('re-using existing pendingRefreshPromise')
    } else {
      this.log.debug('creating new pendingRefreshPromise')
      this.pendingRefreshPromise = this._refreshStatus()
      this.pendingRefreshPromise.finally(() => {
        this.log.debug('clearing pendingRefreshPromise')
        this.pendingRefreshPromise = null
      })
    }
    return this.pendingRefreshPromise
  }

  /** gets status,  updates accessories, and resolves */
  async _refreshStatus() {
    try {
      const blindStatus = await this.blindController.getStatus()
      this.log.debug('connected:', this.blindConfig.serialNumber, '(getStatus)')
      this._updateAccessories(blindStatus, null)
      return null
    } catch (err) {
      this.log.error('error getting blind status', err)
      this._updateAccessories(null, err)
      throw err
    }
  }

  /** updates all accessory data with latest values after a refresh */
  _updateAccessories(status, err) {
    const fault = err ? true : false
    for (const [_key, accessory] of this.blindAccessories) {
      let position = Math.round((status.shades.get(accessory.blindId) / 255) * 100)
      accessory.faultStatus = fault
      accessory.currentPosition = position
      accessory.targetPosition = position
    }
  }

  async setTargetPosition(blindId, position) {
    const blindPosition = (position / 100) * 255
    this.log.debug('setTargetPosition:', blindId, position, blindPosition)
    await this.blindController.setPosition([blindId], blindPosition)
    let blindAccessory = this.blindAccessories.get(blindId)
    blindAccessory.currentPosition = blindPosition
  }

  /** convenience method for accessories */
  getAccessoryInformationService() {
    var informationService = new Service.AccessoryInformation()
    informationService
      .setCharacteristic(Characteristic.Manufacturer, 'HunterDouglas')
      .setCharacteristic(Characteristic.FirmwareRevision, '')
      // store software version in model, since it doesn't follow
      // proper n.n.n format Apple requires and model is a string
      .setCharacteristic(Characteristic.Model, this.blindConfig.softwareVersion)
      .setCharacteristic(Characteristic.SerialNumber, this.device_id)
    return informationService
  }

  /** convenience function to add an `on('get')` handler which refreshes accessory values  */
  bindCharacteristicGet(service, characteristic) {
    const platform = this
    service.getCharacteristic(characteristic).on('get', function(callback) {
      platform
        ._refreshAccessoryValues()
        .then(() => callback(null, this.value))
        .catch(err => callback(err, null))
    })
  }
}
