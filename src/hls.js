// Copyright 2014 Globo.com Player authors. All rights reserved.
// Use of this source code is governed by a BSD-style
// license that can be found in the LICENSE file.

import { Events, HTML5Video, Log, Playback, PlayerError, Utils, version } from '@guzzj/clappr-core'
import HLSJS from 'hls.js'

const { now, assign, listContainsIgnoreCase } = Utils

const AUTO = -1

Events.register('PLAYBACK_FRAGMENT_CHANGED')
Events.register('PLAYBACK_FRAGMENT_PARSING_METADATA')

export default class HlsjsPlayback extends HTML5Video {
  get name() { return 'hls' }

  get supportedVersion() { return { min: version } }

  get levels() { return this._levels || [] }

  get currentLevel() {
    if (this._currentLevel === null || this._currentLevel === undefined)
      return AUTO
    else
      return this._currentLevel //0 is a valid level ID

  }

  get currentAudioTrack() {
    if (this._currentAudioTrack === null || this._currentAudioTrack === undefined)
      return AUTO
    else
      return this._currentAudioTrack //0 is a valid level ID

  }

  get isReady() {
    return this._isReadyState
  }

  set currentLevel(id) {
    this._currentLevel = id
    this.trigger(Events.PLAYBACK_LEVEL_SWITCH_START)
    if (this.options.playback.hlsUseNextLevel)
      this._hls.nextLevel = this._currentLevel
    else
      this._hls.currentLevel = this._currentLevel
  }

  set currentAudioTrack(lang) {
    this._currentAudioTrack = lang
    this.trigger(Events.PLAYBACK_AUDIO_TRACK_SWITCH_START)
    const trackId = this._getAudioTrackId(lang)
    this._hls.audioTrack = trackId
  }

  get _startTime() {
    if (this._playbackType === Playback.LIVE && this._playlistType !== 'EVENT')
      return this._extrapolatedStartTime

    return this._playableRegionStartTime
  }

  get _now() {
    return now()
  }

  // the time in the video element which should represent the start of the sliding window
  // extrapolated to increase in real time (instead of jumping as the early segments are removed)
  get _extrapolatedStartTime() {
    if (!this._localStartTimeCorrelation)
      return this._playableRegionStartTime

    let corr = this._localStartTimeCorrelation
    let timePassed = this._now - corr.local
    let extrapolatedWindowStartTime = (corr.remote + timePassed) / 1000
    // cap at the end of the extrapolated window duration
    return Math.min(extrapolatedWindowStartTime, this._playableRegionStartTime + this._extrapolatedWindowDuration)
  }

  // the time in the video element which should represent the end of the content
  // extrapolated to increase in real time (instead of jumping as segments are added)
  get _extrapolatedEndTime() {
    let actualEndTime = this._playableRegionStartTime + this._playableRegionDuration
    if (!this._localEndTimeCorrelation)
      return actualEndTime

    let corr = this._localEndTimeCorrelation
    let timePassed = this._now - corr.local
    let extrapolatedEndTime = (corr.remote + timePassed) / 1000
    return Math.max(actualEndTime - this._extrapolatedWindowDuration, Math.min(extrapolatedEndTime, actualEndTime))
  }

  get _duration() {
    return this._extrapolatedEndTime - this._startTime
  }

  // Returns the duration (seconds) of the window that the extrapolated start time is allowed
  // to move in before being capped.
  // The extrapolated start time should never reach the cap at the end of the window as the
  // window should slide as chunks are removed from the start.
  // This also applies to the extrapolated end time in the same way.
  //
  // If chunks aren't being removed for some reason that the start time will reach and remain fixed at
  // playableRegionStartTime + extrapolatedWindowDuration
  //
  //                                <-- window duration -->
  // I.e   playableRegionStartTime |-----------------------|
  //                               | -->   .       .       .
  //                               .   --> | -->   .       .
  //                               .       .   --> | -->   .
  //                               .       .       .   --> |
  //                               .       .       .       .
  //                                 extrapolatedStartTime
  get _extrapolatedWindowDuration() {
    if (this._segmentTargetDuration === null)
      return 0

    return this._extrapolatedWindowNumSegments * this._segmentTargetDuration
  }

  get bandwidthEstimate() {
    return this._hls && this._hls.bandwidthEstimate
  }

  static get HLSJS() {
    return HLSJS
  }

  constructor(...args) {
    super(...args)
    // backwards compatibility (TODO: remove on 0.3.0)
    this.options.playback = { ...this.options, ...this.options.playback }
    this._minDvrSize = typeof (this.options.hlsMinimumDvrSize) === 'undefined' ? 60 : this.options.hlsMinimumDvrSize
    // The size of the start time extrapolation window measured as a multiple of segments.
    // Should be 2 or higher, or 0 to disable. Should only need to be increased above 2 if more than one segment is
    // removed from the start of the playlist at a time. E.g if the playlist is cached for 10 seconds and new chunks are
    // added/removed every 5.
    this._extrapolatedWindowNumSegments = !this.options.playback || typeof (this.options.playback.extrapolatedWindowNumSegments) === 'undefined' ? 2 :  this.options.playback.extrapolatedWindowNumSegments

    this._playbackType = Playback.VOD
    this._lastTimeUpdate = { current: 0, total: 0 }
    this._lastDuration = null
    // for hls streams which have dvr with a sliding window,
    // the content at the start of the playlist is removed as new
    // content is appended at the end.
    // this means the actual playable start time will increase as the
    // start content is deleted
    // For streams with dvr where the entire recording is kept from the
    // beginning this should stay as 0
    this._playableRegionStartTime = 0
    // {local, remote} remote is the time in the video element that should represent 0
    //                 local is the system time when the 'remote' measurment took place
    this._localStartTimeCorrelation = null
    // {local, remote} remote is the time in the video element that should represents the end
    //                 local is the system time when the 'remote' measurment took place
    this._localEndTimeCorrelation = null
    // if content is removed from the beginning then this empty area should
    // be ignored. "playableRegionDuration" excludes the empty area
    this._playableRegionDuration = 0
    // #EXT-X-PROGRAM-DATE-TIME
    this._programDateTime = 0
    // true when the actual duration is longer than hlsjs's live sync point
    // when this is false playableRegionDuration will be the actual duration
    // when this is true playableRegionDuration will exclude the time after the sync point
    this._durationExcludesAfterLiveSyncPoint = false
    // #EXT-X-TARGETDURATION
    this._segmentTargetDuration = null
    // #EXT-X-PLAYLIST-TYPE
    this._playlistType = null
    this._recoverAttemptsRemaining = this.options.hlsRecoverAttempts || 16
  }

  _setup() {
    this._ccIsSetup = false
    this._ccTracksUpdated = false
    this._hls && this._hls.destroy()
    this._hls = new HLSJS(assign({}, this.options.playback.hlsjsConfig))
    this._hls.once(HLSJS.Events.MEDIA_ATTACHED, () => this._hls.loadSource(this.options.src))
    this._hls.on(HLSJS.Events.LEVEL_LOADED, (evt, data) => this._updatePlaybackType(evt, data))
    this._hls.on(HLSJS.Events.LEVEL_UPDATED, (evt, data) => this._onLevelUpdated(evt, data))
    this._hls.on(HLSJS.Events.LEVEL_SWITCHING, (evt,data) => this._onLevelSwitch(evt, data))
    this._hls.on(HLSJS.Events.FRAG_CHANGED, (evt, data) => this._onFragmentChanged(evt, data))
    this._hls.on(HLSJS.Events.FRAG_LOADED, (evt, data) => this._onFragmentLoaded(evt, data))
    this._hls.on(HLSJS.Events.FRAG_PARSING_METADATA, (evt, data) => this._onFragmentParsingMetadata(evt, data))
    this._hls.on(HLSJS.Events.ERROR, (evt, data) => this._onHLSJSError(evt, data))
    this._hls.on(HLSJS.Events.SUBTITLE_TRACK_LOADED, (evt, data) => this._onSubtitleLoaded(evt, data))
    this._hls.on(HLSJS.Events.SUBTITLE_TRACKS_UPDATED, () => this._ccTracksUpdated = true)
    this._hls.on(HLSJS.Events.AUDIO_TRACKS_UPDATED, (evt, data) => this._loadAudioTracks(evt, data))
    this._hls.on(HLSJS.Events.AUDIO_TRACKS_SWITCHED, (evt, data) => this.trigger(Events.PLAYBACK_AUDIO_TRACK_SWITCH_END))
    this._hls.attachMedia(this.el)
  }

  _onFragmentParsingMetadata(evt, data) {
    this.trigger(Events.Custom.PLAYBACK_FRAGMENT_PARSING_METADATA, { evt, data })
  }

  render() {
    this._ready()
    return super.render()
  }

  _ready() {
    this._isReadyState = true
    this.trigger(Events.PLAYBACK_READY, this.name)
  }

  _recover(evt, data, error) {
    if (!this._recoveredDecodingError) {
      this._recoveredDecodingError = true
      this._hls.recoverMediaError()
    } else if (!this._recoveredAudioCodecError) {
      this._recoveredAudioCodecError = true
      this._hls.swapAudioCodec()
      this._hls.recoverMediaError()
    } else {
      Log.error('hlsjs: failed to recover', { evt, data })
      error.level = PlayerError.Levels.FATAL
      const formattedError = this.createError(error)
      this.trigger(Events.PLAYBACK_ERROR, formattedError)
      this.stop()
    }
  }

  // override
  _setupSrc(srcUrl) { // eslint-disable-line no-unused-vars
    // this playback manages the src on the video element itself
  }

  _startTimeUpdateTimer() {
    if (this._timeUpdateTimer) return

    this._timeUpdateTimer = setInterval(() => {
      this._onDurationChange()
      this._onTimeUpdate()
    }, 100)
  }

  _stopTimeUpdateTimer() {
    if (!this._timeUpdateTimer) return

    clearInterval(this._timeUpdateTimer)
    this._timeUpdateTimer = null
  }

  getProgramDateTime() {
    return this._programDateTime
  }
  // the duration on the video element itself should not be used
  // as this does not necesarily represent the duration of the stream
  // https://github.com/clappr/clappr/issues/668#issuecomment-157036678
  getDuration() {
    return this._duration
  }

  getCurrentTime() {
    // e.g. can be < 0 if user pauses near the start
    // eventually they will then be kicked to the end by hlsjs if they run out of buffer
    // before the official start time
    return Math.max(0, this.el.currentTime - this._startTime)
  }

  // the time that "0" now represents relative to when playback started
  // for a stream with a sliding window this will increase as content is
  // removed from the beginning
  getStartTimeOffset() {
    return this._startTime
  }

  seekPercentage(percentage) {
    let seekTo = this._duration
    if (percentage > 0)
      seekTo = this._duration * (percentage / 100)

    this.seek(seekTo)
  }

  seek(time) {
    if (time < 0) {
      Log.warn('Attempt to seek to a negative time. Resetting to live point. Use seekToLivePoint() to seek to the live point.')
      time = this.getDuration()
    }
    // assume live if time within 3 seconds of end of stream
    this.dvrEnabled && this._updateDvr(time < this.getDuration()-3)
    time += this._startTime
    this.el.currentTime = time
  }

  seekToLivePoint() {
    this.seek(this.getDuration())
  }

  _updateDvr(status) {
    this.trigger(Events.PLAYBACK_DVR, status)
    this.trigger(Events.PLAYBACK_STATS_ADD, { 'dvr': status })
  }

  _updateSettings() {
    if (this._playbackType === Playback.VOD)
      this.settings.left = ['playpause', 'position', 'duration']
    else if (this.dvrEnabled)
      this.settings.left = ['playpause']
    else
      this.settings.left = ['playstop']

    this.settings.seekEnabled = this.isSeekEnabled()
    this.trigger(Events.PLAYBACK_SETTINGSUPDATE)
  }

  _onHLSJSError(evt, data) {
    const error = {
      code: `${data.type}_${data.details}`,
      description: `${this.name} error: type: ${data.type}, details: ${data.details}`,
      raw: data,
    }
    let formattedError
    if (data.response) error.description += `, response: ${JSON.stringify(data.response)}`
    // only report/handle errors if they are fatal
    // hlsjs should automatically handle non fatal errors
    if (data.fatal) {
      if (this._recoverAttemptsRemaining > 0) {
        this._recoverAttemptsRemaining -= 1
        switch (data.type) {
        case HLSJS.ErrorTypes.NETWORK_ERROR:
          switch (data.details) {
          // The following network errors cannot be recovered with HLS.startLoad()
          // For more details, see https://github.com/video-dev/hls.js/blob/master/doc/design.md#error-detection-and-handling
          // For "level load" fatal errors, see https://github.com/video-dev/hls.js/issues/1138
          case HLSJS.ErrorDetails.MANIFEST_LOAD_ERROR:
          case HLSJS.ErrorDetails.MANIFEST_LOAD_TIMEOUT:
          case HLSJS.ErrorDetails.MANIFEST_PARSING_ERROR:
          case HLSJS.ErrorDetails.LEVEL_LOAD_ERROR:
          case HLSJS.ErrorDetails.LEVEL_LOAD_TIMEOUT:
            Log.error('hlsjs: unrecoverable network fatal error.', { evt, data })
            formattedError = this.createError(error)
            this.trigger(Events.PLAYBACK_ERROR, formattedError)
            this.stop()
            break
          default:
            Log.warn('hlsjs: trying to recover from network error.', { evt, data })
            error.level = PlayerError.Levels.WARN
            this._hls.startLoad()
            break
          }
          break
        case HLSJS.ErrorTypes.MEDIA_ERROR:
          Log.warn('hlsjs: trying to recover from media error.', { evt, data })
          error.level = PlayerError.Levels.WARN
          this._recover(evt, data, error)
          break
        default:
          Log.error('hlsjs: could not recover from error.', { evt, data })
          formattedError = this.createError(error)
          this.trigger(Events.PLAYBACK_ERROR, formattedError)
          this.stop()
          break
        }
      } else {
        Log.error('hlsjs: could not recover from error after maximum number of attempts.', { evt, data })
        formattedError = this.createError(error)
        this.trigger(Events.PLAYBACK_ERROR, formattedError)
        this.stop()
      }
    } else {
      // Transforms HLSJS.ErrorDetails.KEY_LOAD_ERROR non-fatal error to
      // playback fatal error if triggerFatalErrorOnResourceDenied playback
      // option is set. HLSJS.ErrorTypes.KEY_SYSTEM_ERROR are fatal errors
      // and therefore already handled.
      if (this.options.playback.triggerFatalErrorOnResourceDenied && this._keyIsDenied(data)) {
        Log.error('hlsjs: could not load decrypt key.', { evt, data })
        formattedError = this.createError(error)
        this.trigger(Events.PLAYBACK_ERROR, formattedError)
        this.stop()
        return
      }

      error.level = PlayerError.Levels.WARN
      Log.warn('hlsjs: non-fatal error occurred', { evt, data })
    }
  }

  _keyIsDenied(data) {
    return data.type === HLSJS.ErrorTypes.NETWORK_ERROR
      && data.details === HLSJS.ErrorDetails.KEY_LOAD_ERROR
      && data.response
      && data.response.code >= 400
  }

  _onTimeUpdate() {
    let update = { current: this.getCurrentTime(), total: this.getDuration(), firstFragDateTime: this.getProgramDateTime() }
    let isSame = this._lastTimeUpdate && (
      update.current === this._lastTimeUpdate.current &&
      update.total === this._lastTimeUpdate.total)
    if (isSame)
      return

    this._lastTimeUpdate = update
    this.trigger(Events.PLAYBACK_TIMEUPDATE, update, this.name)
  }

  _onDurationChange() {
    let duration = this.getDuration()
    if (this._lastDuration === duration)
      return

    this._lastDuration = duration
    super._onDurationChange()
  }

  _onProgress() {
    if (!this.el.buffered.length)
      return

    let buffered = []
    let bufferedPos = 0
    for (let i = 0; i < this.el.buffered.length; i++) {
      buffered = [...buffered, {
        // for a stream with sliding window dvr something that is buffered my slide off the start of the timeline
        start: Math.max(0, this.el.buffered.start(i) - this._playableRegionStartTime),
        end: Math.max(0, this.el.buffered.end(i) - this._playableRegionStartTime)
      }]
      if (this.el.currentTime >= buffered[i].start && this.el.currentTime <= buffered[i].end)
        bufferedPos = i

    }
    const progress = {
      start: buffered[bufferedPos].start,
      current: buffered[bufferedPos].end,
      total: this.getDuration()
    }
    this.trigger(Events.PLAYBACK_PROGRESS, progress, buffered)
  }

  play() {
    if (!this._hls)
      this._setup()

    super.play()
    this._startTimeUpdateTimer()
  }

  pause() {
    if (!this._hls) return
    this.el.pause()
    if (this.dvrEnabled) this._updateDvr(true)
  }

  stop() {
    this._stopTimeUpdateTimer()
    if (this._hls) {
      super.stop()
      this._hls.destroy()
      delete this._hls
    }
  }

  destroy() {
    this._stopTimeUpdateTimer()
    if (this._hls) {
      this._hls.destroy()
      delete this._hls
    }
    super.destroy()
  }

  _updatePlaybackType(evt, data) {
    this._playbackType = data.details.live ? Playback.LIVE : Playback.VOD
    this._onLevelUpdated(evt, data)

    // Live stream subtitle tracks detection hack (may not immediately available)
    if (this._ccTracksUpdated && this._playbackType === Playback.LIVE && this.hasClosedCaptionsTracks)
      this._onSubtitleLoaded()

  }

  _fillLevels() {
    this._levels = this._hls.levels.map((level, index) => {
      return { id: index, level: level, audioGroupIds: level.audioGroupIds, label: `${level.bitrate/1000}Kbps` }
    })
    this.trigger(Events.PLAYBACK_LEVELS_AVAILABLE, this._levels)
  }

  _onLevelUpdated(evt, data) {
    this._segmentTargetDuration = data.details.targetduration
    this._playlistType = data.details.type || null

    let startTimeChanged = false
    let durationChanged = false
    let fragments = data.details.fragments
    let previousPlayableRegionStartTime = this._playableRegionStartTime
    let previousPlayableRegionDuration = this._playableRegionDuration

    if (fragments.length === 0)
      return


    // #EXT-X-PROGRAM-DATE-TIME
    if (fragments[0].rawProgramDateTime)
      this._programDateTime = fragments[0].rawProgramDateTime


    if (this._playableRegionStartTime !== fragments[0].start) {
      startTimeChanged = true
      this._playableRegionStartTime = fragments[0].start
    }

    if (startTimeChanged) {
      if (!this._localStartTimeCorrelation) {
        // set the correlation to map to middle of the extrapolation window
        this._localStartTimeCorrelation = {
          local: this._now,
          remote: (fragments[0].start + (this._extrapolatedWindowDuration/2)) * 1000
        }
      } else {
        // check if the correlation still works
        let corr = this._localStartTimeCorrelation
        let timePassed = this._now - corr.local
        // this should point to a time within the extrapolation window
        let startTime = (corr.remote + timePassed) / 1000
        if (startTime < fragments[0].start) {
          // our start time is now earlier than the first chunk
          // (maybe the chunk was removed early)
          // reset correlation so that it sits at the beginning of the first available chunk
          this._localStartTimeCorrelation = {
            local: this._now,
            remote: fragments[0].start * 1000
          }
        } else if (startTime > previousPlayableRegionStartTime + this._extrapolatedWindowDuration) {
          // start time was past the end of the old extrapolation window (so would have been capped)
          // see if now that time would be inside the window, and if it would be set the correlation
          // so that it resumes from the time it was at at the end of the old window
          // update the correlation so that the time starts counting again from the value it's on now
          this._localStartTimeCorrelation = {
            local: this._now,
            remote: Math.max(fragments[0].start, previousPlayableRegionStartTime + this._extrapolatedWindowDuration) * 1000
          }
        }
      }
    }

    let newDuration = data.details.totalduration
    // if it's a live stream then shorten the duration to remove access
    // to the area after hlsjs's live sync point
    // seeks to areas after this point sometimes have issues
    if (this._playbackType === Playback.LIVE) {
      let fragmentTargetDuration = data.details.targetduration
      let hlsjsConfig = this.options.playback.hlsjsConfig || {}
      let liveSyncDurationCount = hlsjsConfig.liveSyncDurationCount || HLSJS.DefaultConfig.liveSyncDurationCount
      let hiddenAreaDuration = fragmentTargetDuration * liveSyncDurationCount
      if (hiddenAreaDuration <= newDuration) {
        newDuration -= hiddenAreaDuration
        this._durationExcludesAfterLiveSyncPoint = true
      } else { this._durationExcludesAfterLiveSyncPoint = false }

    }

    if (newDuration !== this._playableRegionDuration) {
      durationChanged = true
      this._playableRegionDuration = newDuration
    }

    // Note the end time is not the playableRegionDuration
    // The end time will always increase even if content is removed from the beginning
    let endTime = fragments[0].start + newDuration
    let previousEndTime = previousPlayableRegionStartTime + previousPlayableRegionDuration
    let endTimeChanged = endTime !== previousEndTime
    if (endTimeChanged) {
      if (!this._localEndTimeCorrelation) {
        // set the correlation to map to the end
        this._localEndTimeCorrelation = {
          local: this._now,
          remote: endTime * 1000
        }
      } else {
        // check if the correlation still works
        let corr = this._localEndTimeCorrelation
        let timePassed = this._now - corr.local
        // this should point to a time within the extrapolation window from the end
        let extrapolatedEndTime = (corr.remote + timePassed) / 1000
        if (extrapolatedEndTime > endTime) {
          this._localEndTimeCorrelation = {
            local: this._now,
            remote: endTime * 1000
          }
        } else if (extrapolatedEndTime < endTime - this._extrapolatedWindowDuration) {
          // our extrapolated end time is now earlier than the extrapolation window from the actual end time
          // (maybe a chunk became available early)
          // reset correlation so that it sits at the beginning of the extrapolation window from the end time
          this._localEndTimeCorrelation = {
            local: this._now,
            remote: (endTime - this._extrapolatedWindowDuration) * 1000
          }
        } else if (extrapolatedEndTime > previousEndTime) {
          // end time was past the old end time (so would have been capped)
          // set the correlation so that it resumes from the time it was at at the end of the old window
          this._localEndTimeCorrelation = {
            local: this._now,
            remote: previousEndTime * 1000
          }
        }
      }
    }

    // now that the values have been updated call any methods that use on them so they get the updated values
    // immediately
    durationChanged && this._onDurationChange()
    startTimeChanged && this._onProgress()
  }

  _onFragmentChanged(evt, data) {
    this.trigger(Events.Custom.PLAYBACK_FRAGMENT_CHANGED, data)
  }

  _onFragmentLoaded(evt, data) {
    this.trigger(Events.PLAYBACK_FRAGMENT_LOADED, data)
  }

  _onSubtitleLoaded(event, data) {
    // This event may be triggered multiple times
    // Setup CC only once (disable CC by default)
    if (!this._ccIsSetup) {
      this.trigger(Events.PLAYBACK_SUBTITLE_AVAILABLE)
      const trackId = this._playbackType === Playback.LIVE ? -1 : this.closedCaptionsTrackId
      this.closedCaptionsTrackId = trackId
      this._ccIsSetup = true
    }
  }

  _onLevelSwitch(evt, data) {
    if (!this.levels.length)
      this._fillLevels()

    this.trigger(Events.PLAYBACK_LEVEL_SWITCH_END)
    this.trigger(Events.PLAYBACK_LEVEL_SWITCH, data)
    let currentLevel = this._hls.levels[data.level]
    if (currentLevel) {
      // TODO should highDefinition be private and maybe have a read only accessor if it's used somewhere
      this.highDefinition = (currentLevel.height >= 720 || (currentLevel.bitrate / 1000) >= 2000)
      this.trigger(Events.PLAYBACK_HIGHDEFINITIONUPDATE, this.highDefinition)
      this.trigger(Events.PLAYBACK_BITRATE, {
        height: currentLevel.height,
        width: currentLevel.width,
        bandwidth: currentLevel.bitrate,
        bitrate: currentLevel.bitrate,
        level: data.level
      })
    }
  }

  _loadAudioTracks(evt, data) {
    const langs = [...new Set(data.audioTracks.map(at => at.lang))]
    const audioTracks = []
    for (let i = 0; langs.length > i; i++) {
      const langsTracks = data.audioTracks.filter(at => at.lang === langs[i])
      const audioTrack = {
        lang: langs[i],
        name: langsTracks[0].name,
        url: langsTracks[0].url,
        type: langsTracks[0].type,
        default: !!langsTracks.filter(at => at.default),
        byGroups: langsTracks.map(at => {
          return {
            id: at.id,
            groupId: at.groupId
          }
        })
      }
      audioTracks.push(audioTrack)
    }
    this._audioTracks = audioTracks
    this._currentAudioTrack = audioTracks.filter(at => at.default).lang
    this.trigger(Events.PLAYBACK_AUDIO_TRACKS_AVAILABLE, this._audioTracks)
  }

  _getAudioTrackId(lang) {
    const currentLevel = this._hls.currentLevel
    const audioTracks = this._audioTracks.filter(at => at.lang === lang).byGroups
    const trackId = audioTracks.filter(at => currentLevel.audioGroupIds.includes(at.groupId))[0].id
    return trackId
  }

  get dvrEnabled() {
    // enabled when:
    // - the duration does not include content after hlsjs's live sync point
    // - the playable region duration is longer than the configured duration to enable dvr after
    // - the playback type is LIVE.
    return (this._durationExcludesAfterLiveSyncPoint && this._duration >= this._minDvrSize && this.getPlaybackType() === Playback.LIVE)
  }

  getPlaybackType() {
    return this._playbackType
  }

  isSeekEnabled() {
    return (this._playbackType === Playback.VOD || this.dvrEnabled)
  }
}

HlsjsPlayback.canPlay = function(resource, mimeType) {
  const resourceParts = resource.split('?')[0].match(/.*\.(.*)$/) || []
  const isHls = ((resourceParts.length > 1 && resourceParts[1].toLowerCase() === 'm3u8') || listContainsIgnoreCase(mimeType, ['application/vnd.apple.mpegurl', 'application/x-mpegURL']))

  return !!(HLSJS.isSupported() && isHls)
}
