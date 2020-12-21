/* eslint-disable no-constant-condition */
/* eslint-disable @typescript-eslint/ban-ts-comment */
/* Extracted and modified from TETR.IO source code */
import {Response} from 'node-fetch';
import * as msgpack from 'msgpack-lite';
import 'colors';
import * as WebSocket from 'isomorphic-ws';

const RIBBON_CLOSE_CODES = {
  '1000': 'ribbon closed normally',
  '1001': 'client closed ribbon',
  '1002': 'protocol error',
  '1003': 'protocol violation',
  '1006': 'ribbon lost',
  '1007': 'payload data corrupted',
  '1008': 'protocol violation',
  '1009': 'too much data',
  '1010': 'negotiation error',
  '1011': 'server error',
  '1012': 'server restarting',
  '1013': 'temporary error',
  '1014': 'bad gateway',
  '1015': 'TLS error',
};
const RIBBON_EXTRACTED_ID_TAG = new Uint8Array([174]);
const RIBBON_STANDARD_ID_TAG = new Uint8Array([69]);
const RIBBON_BATCH_TAG = new Uint8Array([88]);
const RIBBON_BATCH_TIMEOUT = 25;
export type Message = {
  command: string;
  id?: number;
  data?: any;
  reason?: any;
  socketId?: string | null;
  resumeToken?: string | null;
  packets?: Message[];
  resume?: string;
  items?: Message[];
};
/**
 * Ribbon - blazing-fast, msgpacked resumable WebSockets
 */
export class RibbonManager {
  /**
   * The number of reconnects that have been tried for the current session
   */
  reconnectCount = 0;
  lastReconnect = 0;
  extraPenalty = 0;
  ws?: WebSocket = undefined;
  /**
   * The ID of the Ribbon
   */
  id?: string = undefined;
  /**
   * Resume ID for Ribbon, used for continuity after disconnects
   */
  resume?: string = undefined;
  /**
   * The ID of the last sent packet
   */
  lastSentId = 0;
  /**
   * The ID of the last received packet
   */
  lastReceivedId = 0;
  /**
   * List of the last 200 messages
   */
  lastSent: Message[] = [];
  /**
   * Is the connection considered alive?
   */
  alive = true;
  /**
   * Reason the ribbon has been closed.
   */
  closeReason = 'ribbon lost';
  /**
   * Object containing all of the current message listeners.
   */
  messageListeners: Record<string, ((data: any) => void)[]> = {};
  /**
   * Array of all onopen() listeners
   */
  openListeners: (() => void)[] = [];
  /**
   * Array of all onclose() listeners
   */
  closeListeners: ((closeReason: string) => void)[] = [];
  /**
   * Array of all onpong() listeners
   */
  pongListeners: ((delta: number) => void)[] = [];
  /**
   * Array of all onresume() listeners
   */
  resumeListeners: ((arg0: number) => void)[] = [];
  /**
   * Current pingInterval ID
   */
  pingInterval?: NodeJS.Timeout = undefined;
  /**
   * Time of the last ping, in ms
   */
  lastPing = 0;
  /**
   * Will attempt to reconnect
   */
  mayReconnect = true;
  /**
   * Connection is dead
   */
  dead = false;
  ignoreCleanness = false;
  /**
   * We've pinged out; trying to reestablish connection
   */
  pingIssues = false;
  /**
   * It has connected at least once in the RibbonManager's lifetime
   */
  wasEverConnected = false;
  ribbonSessionId = `SESS-${Math.floor(
    Math.random() * Number.MAX_SAFE_INTEGER
  )}`;
  /**
   * List of all Messages that need to be processed
   */
  incomingQueue: Message[] = [];
  /**
   * We're about to switch endpoints
   */
  switchingEndpoint = false;
  /**
   * List of packets that should be sent on request
   */
  batchQueue: Uint8Array[] = [];
  /**
   * Current batchQueue interval ID
   */
  batchTimeout?: NodeJS.Timeout = undefined;
  /**
   * Current endpoint
   */
  endpoint: string;
  /**
   * Initialize a ribbon
   * @param uri WebSocket Endpoint to connect to
   */
  constructor(uri = 'wss://tetr.io/ribbon') {
    this.endpoint = uri;

    this.pingInterval = setInterval(() => {
      if (!this.alive) {
        // we're pinging out, get our ass a new connection
        this.pingIssues = true;
        console.warn(
          'Ping timeout in ribbon. Abandoning current socket and obtaining a new one...'
        );
        this.closeReason = 'ping timeout';
        this.reconnect();
      }
      this.alive = false;
      if (this.ws && this.ws.readyState === 1) {
        this.lastPing = Date.now();
        try {
          if (this.ws.readyState === 1) {
            this.ws.send(this.SmartEncode({command: 'ping'}));
          }
        } catch (ex) {
          //
        }
      }
    }, 5000);
  }

  /**
   * Smartly decide which method to send a message with
   * @param packet The message you want to encode
   */
  SmartEncode(packet: Message) {
    let prependable = RIBBON_STANDARD_ID_TAG;

    if (typeof packet === 'object' && packet.id && packet.command) {
      const id = packet.id;

      prependable = new Uint8Array(5);
      prependable.set(RIBBON_EXTRACTED_ID_TAG, 0);
      const view = new DataView(prependable.buffer);
      view.setUint32(1, id, false);
    }

    const msgpacked = msgpack.encode(packet);
    const merged = new Uint8Array(prependable.length + msgpacked.length);
    merged.set(prependable, 0);
    merged.set(msgpacked, prependable.length);

    return merged;
  }
  /**
   * Decode a packet, automatically detecting which method to use
   * @param packet The binary data to be decoded, as a Uint8Array
   */
  SmartDecode(packet: Uint8Array): Message {
    if (packet[0] === RIBBON_STANDARD_ID_TAG[0]) {
      // simply extract
      return msgpack.decode(packet.slice(1));
    } else if (packet[0] === RIBBON_EXTRACTED_ID_TAG[0]) {
      // extract id and msgpacked, then inject id back in
      const object = msgpack.decode(packet.slice(5));
      const view = new DataView(packet.buffer);
      const id = view.getUint32(1, false);
      object.id = id;

      return object;
    } else if (packet[0] === RIBBON_BATCH_TAG[0]) {
      // ok these are complex, keep looking through the header until you get to the (uint32)0 delimiter
      const items = [];
      const lengths = [];
      const view = new DataView(packet.buffer);

      // Get the lengths
      for (let i = 0; true; i++) {
        const length = view.getUint32(1 + i * 4, false);
        if (length === 0) {
          // We've hit the end of the batch
          break;
        }
        lengths.push(length);
      }

      // Get the items at those lengths
      let pointer = 0;
      for (let i = 0; i < lengths.length; i++) {
        items.push(
          packet.slice(
            1 + lengths.length * 4 + 4 + pointer,
            1 + lengths.length * 4 + 4 + pointer + lengths[i]
          )
        );
        pointer += lengths[i];
      }

      return {command: 'X-MUL', items: items.map(o => this.SmartDecode(o))};
    } else {
      // try just parsing it straight?
      return msgpack.decode(packet);
    }
  }
  /**
   * Connect to the WebSocket and create a Ribbon.
   *
   */
  open() {
    if (this.ws) {
      // Discard the old socket entirely
      this.ws.onopen = () => {};
      this.ws.onmessage = () => {};
      this.ws.onerror = () => {};
      this.ws.onclose = () => {};
      this.ws.close();
    }

    this.ws = new WebSocket(this.endpoint, this.ribbonSessionId);
    this.incomingQueue = [];
    this.ws.onclose = e => {
      this.ignoreCleanness = false;
      // @ts-ignore
      if (RIBBON_CLOSE_CODES[e.code]) {
        // @ts-ignore
        closeReason = RIBBON_CLOSE_CODES[e.code];
      }
      if (this.closeReason === 'ribbon lost' && this.pingIssues) {
        this.closeReason = 'ping timeout';
      }
      if (this.closeReason === 'ribbon lost' && !this.wasEverConnected) {
        this.closeReason = 'failed to connect';
      }
      console.log(`Ribbon ${this.id} closed (${this.closeReason})`);
      this.reconnect();
    };
    this.ws.onopen = () => {
      this.wasEverConnected = true;
      if (this.resume) {
        console.log(`Ribbon ${this.id} resuming`);
        this.ws?.send(
          this.SmartEncode({
            command: 'resume',
            socketId: this.id,
            resumeToken: this.resume,
          })
        );
        this.ws?.send(
          this.SmartEncode({command: 'hello', packets: this.lastSent})
        );
      } else {
        this.ws?.send(this.SmartEncode({command: 'new'}));
      }
    };
    this.ws.onmessage = e => {
      try {
        // @ts-ignore
        new Response(e.data).arrayBuffer().then(ab => {
          const msg = this.SmartDecode(new Uint8Array(ab));
          console.log(JSON.stringify(msg).gray);

          if (msg.command === 'kick') {
            this.mayReconnect = false;
            console.log('Kicked: ' + JSON.stringify(msg.data));
          }

          if (msg.command === 'nope') {
            console.error(`Ribbon ${this.id} noped: (${msg.reason})`);
            this.mayReconnect = false;
            this.closeReason = msg.reason;
            this.close();
          } else if (msg.command === 'hello') {
            // @ts-ignore
            this.id = msg.id;
            console.log(
              `Ribbon ${this.id} ${this.resume ? 'resumed' : 'opened'}`
            );
            this.resume = msg.resume;
            this.alive = true;
            msg.packets?.forEach((p: Message) => {
              this.HandleMessage(p);
            });
            this.openListeners.forEach(l => {
              l();
            });
          } else if (msg.command === 'pong') {
            this.alive = true;
            this.pingIssues = false;
            this.pongListeners.forEach(l => {
              l(Date.now() - this.lastPing);
            });
          } else if (msg.command === 'X-MUL') {
            msg.items?.forEach((m: Message) => {
              this.HandleMessage(m);
            });
          } else {
            this.HandleMessage(msg);
          }
        });
      } catch (ex) {
        console.error('Failed to parse message', ex);
      }
    };
    this.ws.onerror = e => {
      console.log(e);
    };
    this.alive = true;
  }

  /**
   * Compute a message
   * @param msg The message to be handled
   */
  HandleMessage(msg: Message) {
    if (msg.id) {
      if (msg.id <= this.lastReceivedId) {
        return; // already seen this
      }

      this.EnqueueMessage(msg);
      return;
    }

    if (this.messageListeners[msg.command]) {
      this.messageListeners[msg.command].forEach(l => {
        l(msg.data);
      });
    }
  }
  /**
   * Add a message to the processing queue
   * @param msg The message to be added
   */
  EnqueueMessage(msg: Message) {
    if (msg.id === this.lastReceivedId + 1) {
      // we're in order, all good!
      if (this.messageListeners[msg.command]) {
        this.messageListeners[msg.command].forEach(l => {
          l(msg.data);
        });
      }
      this.lastReceivedId = msg.id;
    } else {
      this.incomingQueue.push(msg);
    }

    if (this.incomingQueue.length) {
      // Try to go through these
      this.incomingQueue.sort((a, b) => {
        return (a.id || 0) - (b.id || 0);
      });

      while (this.incomingQueue.length) {
        const trackBackMessage = this.incomingQueue[0];

        if (trackBackMessage.id !== this.lastReceivedId + 1) {
          // no good, wait longer
          break;
        }

        // cool, let's push it
        this.incomingQueue.shift();
        if (this.messageListeners[trackBackMessage.command]) {
          this.messageListeners[trackBackMessage.command].forEach(l => {
            l(trackBackMessage.data);
          });
        }
        this.lastReceivedId = trackBackMessage.id;
      }
    }
    if (this.incomingQueue.length > 600) {
      console.error(
        `Ribbon ${this.id} unrecoverable: ${this.incomingQueue.length} packets out of order`
      );
      this.closeReason = 'too many lost packets';
      this.close();
      return;
    }
  }
  /**
   * Send a message
   * @param command The name of the command to be executed
   * @param data The `data` object of the message
   * @param batched Add message to the {@link batchQueue}
   */
  send(command: string, data: any, batched = false) {
    const packet = {id: ++this.lastSentId, command, data};
    this.lastSent.push(packet);
    if (this.lastSent.length > 200) {
      this.lastSent.shift();
    }

    if (batched) {
      this.batchQueue.push(this.SmartEncode(packet));

      if (!this.batchTimeout) {
        this.batchTimeout = setTimeout(this.FlushBatch, RIBBON_BATCH_TIMEOUT);
      }
      return;
    } else {
      this.FlushBatch();
    }

    try {
      if (this.ws?.readyState === 1) {
        this.ws.send(this.SmartEncode(packet));
      }
    } catch (ex) {
      //
    }
  }
  /**
   * Send all batched messages
   */
  FlushBatch() {
    if (!this.batchQueue.length) {
      return;
    }

    if (this.batchTimeout) {
      clearTimeout(this.batchTimeout);
      this.batchTimeout = undefined;
    }

    // If our batch is only 1 long, we really don't need to go through this painful process
    if (this.batchQueue.length === 1) {
      try {
        if (this.ws?.readyState === 1) {
          this.ws.send(this.batchQueue[0]);
        }
      } catch (ex) {
        //
      }

      this.batchQueue = [];
      return;
    }

    // Get the total size of our payload, so we can prepare a buffer for it
    const totalSize = this.batchQueue.reduce((a, c) => {
      return a + c.length;
    }, 0);
    const buffer = new Uint8Array(
      1 + this.batchQueue.length * 4 + 4 + totalSize
    );
    const view = new DataView(buffer.buffer);

    // Set the tag
    buffer.set(RIBBON_BATCH_TAG, 0);

    // Set the lengths and data blocks
    let pointer = 0;

    for (let i = 0; i < this.batchQueue.length; i++) {
      // Set the length
      view.setUint32(1 + i * 4, this.batchQueue[i].length, false);

      // Set the data
      buffer.set(
        this.batchQueue[i],
        1 + this.batchQueue.length * 4 + 4 + pointer
      );
      pointer += this.batchQueue[i].length;
    }

    // Batch ready to send!
    try {
      if (this.ws?.readyState === 1) {
        this.ws.send(buffer);
      }
    } catch (ex) {
      //
    }

    this.batchQueue = [];
  }
  /**
   * Close the connection and don't reopen
   * @param reason A reason to show the user
   * @param silent Don't trigger close listeners
   * @example
   * // will safely close ribbon on ctrl-c
   * process.on('SIGINT', () => {
   *   ribbon.close('process terminated');
   * });
   */
  close(reason = 'ribbon lost', silent = false) {
    this.mayReconnect = false;
    this.closeReason = reason;
    if (this.ws) {
      this.ws.onclose = () => {};
      try {
        if (this.ws.readyState === 1) {
          this.ws.send(this.SmartEncode({command: 'die'}));
        }
        this.ws.close();
      } catch (ex) {
        //
      }
    }

    this.Die(silent);
  }
  /**
   * Close the connection
   * @param penalty Extra time to wait before reconnecting
   */
  cut(penalty = 0) {
    this.ignoreCleanness = true;
    this.extraPenalty = penalty;
    if (this.ws) {
      this.ws.close();
    }
  }
  /**
   * Reconnect to new endpoint
   */
  switchEndpoint() {
    console.warn(
      `Ribbon ${this.id} changing endpoint (new endpoint: ${this.endpoint})`
    );
    this.ignoreCleanness = true;
    this.switchingEndpoint = true;
    if (this.ws) {
      this.ws.close();
    }
  }

  /**
   * Lose the current Ribbon and attempt to create a new one.
   */
  reconnect() {
    if (!this.switchingEndpoint) {
      if (Date.now() - this.lastReconnect > 40000) {
        this.reconnectCount = 0;
      }
      this.lastReconnect = Date.now();

      if (this.reconnectCount >= 10 || !this.mayReconnect) {
        // Stop bothering
        console.error(
          `Ribbon ${this.id} abandoned: ${
            this.mayReconnect ? 'too many reconnects' : 'may not reconnect'
          }`
        );
        this.Die();
        return;
      }

      console.warn(
        `Ribbon ${this.id} reconnecting in ${
          this.extraPenalty + 5 + 100 * this.reconnectCount
        }ms (reconnects: ${this.reconnectCount + 1})`
      );
      this.resumeListeners.forEach(l => {
        l(this.extraPenalty + 5 + 100 * this.reconnectCount);
      });
    }

    setTimeout(
      () => {
        if (this.dead) {
          console.log(`Canceling reopen of ${this.id}: no longer needed`);
          return;
        }

        this.open();
      },
      this.switchingEndpoint
        ? 0
        : this.extraPenalty + 5 + 100 * this.reconnectCount
    );

    if (this.switchingEndpoint) {
      this.switchingEndpoint = false;
    } else {
      this.reconnectCount++;
      this.extraPenalty = 0;
    }
  }
  /**
   * Finish disconnection process and close listeners
   * @param silent Don't trigger close listeners
   */
  Die(silent = false) {
    if (this.dead) {
      return;
    }
    console.log(`Ribbon ${this.id} dead (${this.closeReason})`);
    this.dead = true;
    this.mayReconnect = false;
    if (!silent) {
      this.closeListeners.forEach(l => {
        l(this.closeReason);
      });
    }
    if (this.ws) {
      this.ws.onopen = () => {};
      this.ws.onmessage = () => {};
      this.ws.onerror = () => {};
      this.ws.onclose = () => {};
    }
    clearInterval(this.pingInterval!);
  }
  getEndpoint() {
    return this.endpoint;
  }
  /**
   * Change current endpoint
   * @param uri New endpoint
   */
  setEndpoint(uri: string) {
    this.endpoint = uri;
  }
  getId() {
    return this.id;
  }
  isAlive() {
    return this.alive;
  }
  onclose(l: (closeReason: string) => void) {
    this.closeListeners.push(l);
  }
  /**
   * Triggered when Ribbon is established
   */
  onopen(l: () => void) {
    this.openListeners.push(l);
  }
  /**
   * Triggered after every 'pong' (server response to ping)
   */
  onPong(l: (delta: number) => void) {
    this.pongListeners.push(l);
  }
  /**
   * Triggered when Ribbon is broken and resumed
   */
  onresume(l: (delay: number) => void) {
    this.resumeListeners.push(l);
  }
  /**
   * Create an event listener for a message
   */
  on(type: string, l: (data: Record<string, any>) => void) {
    if (this.messageListeners[type]) {
      this.messageListeners[type].push(l);
    } else {
      this.messageListeners[type] = [l];
    }
  }
  /**
   * Remove an event listener for a message
   */
  off(type: string, l: (data: Record<string, any>) => void) {
    if (this.messageListeners[type]) {
      if (!l) {
        this.messageListeners[type] = [];
        return;
      } else {
        this.messageListeners[type] = this.messageListeners[type].filter(
          o => o !== l
        );
      }
    }
  }
}

export default RibbonManager;
