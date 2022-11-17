var process = require('process')
// Handle SIGINT
process.on('SIGINT', () => {
  console.info("SIGINT Received, exiting...")
  process.exit(0)
})

// Handle SIGTERM
process.on('SIGTERM', () => {
  console.info("SIGTERM Received, exiting...")
  process.exit(0)
})

const parser = require('ua-parser-js');

class SnapdropServer {

    constructor(port) {
        const WebSocket = require('ws');
        this._wss = new WebSocket.Server({ port: port });
        this._wss.on('connection', (socket, request) => this._onConnection(new Peer(socket, request)));

        this._rooms = {};
        this._keyRooms = {};

        console.log('Snapdrop is running on port', port);
    }

    _onConnection(peer) {
        this._joinRoom(peer);
        if (peer.roomKey) {
            this._joinKeyRoom(peer);
        }
        peer.socket.on('message', message => this._onMessage(peer, message));
        peer.socket.on('error', console.error);
        this._keepAlive(peer);

        // send displayName
        this._send(peer, {
            type: 'display-name',
            message: {
                displayName: peer.name.displayName,
                deviceName: peer.name.deviceName,
                roomIsIp: peer.roomIsIp,
                roomId: peer.roomId,
                roomKey: peer.roomKey
            }
        });
    }

    _onMessage(sender, message) {
        // Try to parse message 
        try {
            message = JSON.parse(message);
        } catch (e) {
            return; // TODO: handle malformed JSON
        }

        switch (message.type) {
            case 'disconnect':
                this._leaveRoom(sender);
                this._leaveKeyRoom(sender);
                break;
            case 'pong':
                sender.lastBeat = Date.now();
                break;
        }

        // relay message to recipient
        if (message.to && this._rooms[sender.ip]) {
            const recipientId = message.to; // TODO: sanitize
            const recipient = this._rooms[sender.ip][recipientId];
            delete message.to;
            // add sender id
            message.sender = sender.id;
            this._send(recipient, message);
            return;
        }
    }

    _joinRoom(peer) {
        // if room doesn't exist, create it
        if (!this._rooms[peer.roomId]) {
            this._rooms[peer.roomId] = {};
        }

        // notify all other peers
        for (const otherPeerId in this._rooms[peer.roomId]) {
            const otherPeer = this._rooms[peer.roomId][otherPeerId];
            this._send(otherPeer, {
                type: 'peer-joined',
                peer: peer.getInfo()
            });
        }

        // notify peer about the other peers
        const otherPeers = [];
        for (const otherPeerId in this._rooms[peer.roomId]) {
            otherPeers.push(this._rooms[peer.roomId][otherPeerId].getInfo());
        }

        this._send(peer, {
            type: 'peers',
            peers: otherPeers
        });

        // add peer to room
        this._rooms[peer.roomId][peer.id] = peer;
    }

    _leaveRoom(peer) {
        if (!this._rooms[peer.roomId] || !this._rooms[peer.roomId][peer.id]) return;
        this._cancelKeepAlive(this._rooms[peer.roomId][peer.id]);

        // delete the peer
        delete this._rooms[peer.roomId][peer.id];

        peer.socket.terminate();
        //if room is empty, delete the room
        if (!Object.keys(this._rooms[peer.roomId]).length) {
            delete this._rooms[peer.roomId];
        } else {
            // notify all other peers
            for (const otherPeerId in this._rooms[peer.roomId]) {
                const otherPeer = this._rooms[peer.roomId][otherPeerId];
                this._send(otherPeer, { type: 'peer-left', peerId: peer.id });
            }
        }
    }

    _joinKeyRoom(peer) {
        if (!peer.roomIsIp) {
            //goal: create keyRoom
            if (this._keyRooms[peer.roomKey]) {
                // peer tries to create new keyRoom that already exists
                this._send(peer, {
                    type: 'key-room-full',
                    roomKey: peer.roomKey
                });
                return;
            }
            this._keyRooms[peer.roomKey] = {};
            this._send(peer, {
                type: 'key-room-created',
                roomKey: peer.roomKey
            });
            // add peer to room
            this._keyRooms[peer.roomKey][peer.id] = peer;
            // delete room automatically after 10 min
            this.keyRoomTimer = setTimeout(() => this._deleteKeyRoom(peer.roomKey), 600000)
        } else {
            //goal: join keyRoom
            if (!this._keyRooms[peer.roomKey]) {
                // no keyRoom exists to roomKey -> invalid
                this._send(peer, {
                    type: 'key-room-invalid-room-key',
                    roomKey: peer.roomKey
                });
                return;
            }
            // keyRoom exists and peer wants to join room
            const firstPeer = Object.values(this._keyRooms[peer.roomKey])[0];
            this._send(peer, {
                type: 'key-room-room-id',
                roomId: firstPeer.roomId
            });
            this._send(firstPeer, {
                type: 'key-room-room-id-received',
                roomKey: peer.roomKey
            })
        }
    }

    _leaveKeyRoom(peer) {
        if (!this._keyRooms[peer.roomKey] || !this._keyRooms[peer.roomKey][peer.id]) return;

        const firstPeerId = Object.keys(this._keyRooms[peer.roomKey])[0];

        // delete the peer
        delete this._keyRooms[peer.roomKey][peer.id];

        //if room is empty or leaving peer is creating peer, delete the room
        if (!Object.keys(this._keyRooms[peer.roomKey]).length || firstPeerId === peer.id) {
            this._deleteKeyRoom(peer.roomKey);
            clearTimeout(this.keyRoomTimer);
        }
    }

    _deleteKeyRoom(roomKey) {
        if (!this._keyRooms[roomKey]) return;

        for (const peerId in this._keyRooms[roomKey]) {
            const peer = this._keyRooms[roomKey][peerId];
            this._send(peer, {
                type: 'key-room-deleted',
                roomKey: roomKey
            });
        }

        delete this._keyRooms[roomKey];
    }

    _send(peer, message) {
        if (!peer) return;
        if (this._wss.readyState !== this._wss.OPEN) return;
        message = JSON.stringify(message);
        peer.socket.send(message, error => '');
    }

    _keepAlive(peer) {
        this._cancelKeepAlive(peer);
        var timeout = 30000;
        if (!peer.lastBeat) {
            peer.lastBeat = Date.now();
        }
        if (Date.now() - peer.lastBeat > 2 * timeout) {
            this._leaveRoom(peer);
            return;
        }

        this._send(peer, { type: 'ping' });

        peer.timerId = setTimeout(() => this._keepAlive(peer), timeout);
    }

    _cancelKeepAlive(peer) {
        if (peer && peer.timerId) {
            clearTimeout(peer.timerId);
        }
    }
}

class Peer {

    constructor(socket, request) {
        // set socket
        this.socket = socket;

        // set peer id, code, room
        this._setPeerValues(request);

        // is WebRTC supported ?
        this.rtcSupported = request.url.indexOf('webrtc') > -1;
        // set name 
        this._setName(request);
        // for keepalive
        this.timerId = 0;
        this.lastBeat = Date.now();
    }

    _setPeerValues(request) {
        let params = (new URL(request.url, "http://server")).searchParams;
        this.id = params.get("peerid");
        this.code = params.get("code");
        let incomeRoomId = params.get("roomid")

        if (incomeRoomId === "null") {
            this.roomId = this._getIP(request)
            this.roomIsIp = true;
        } else {
            this.roomId = incomeRoomId;
            this.roomIsIp = false;
        }
        let roomKey = params.get("roomkey").replace(/\D/g,'');
        if (roomKey.length === 6 && !isNaN(roomKey)) this.roomKey = roomKey;
    }

    _getIP(request) {
        let ip;
        ip = request.headers['x-forwarded-for']
            ? request.headers['x-forwarded-for'].split(/\s*,\s*/)[0]
            : request.connection.remoteAddress;

        // IPv4 and IPv6 use different values to refer to localhost
        if (ip == '::1' || ip == '::ffff:127.0.0.1') {
            ip = '127.0.0.1';
        }

        return ip;
    }

    toString() {
        return `<Peer id=${this.id} roomId=${this.roomId} rtcSupported=${this.rtcSupported}>`
    }

    _setName(req) {
        let ua = parser(req.headers['user-agent']);


        let deviceName = '';
        
        if (ua.os && ua.os.name) {
            deviceName = ua.os.name.replace('Mac OS', 'Mac') + ' ';
        }
        
        if (ua.device.model) {
            deviceName += ua.device.model;
        } else {
            deviceName += ua.browser.name;
        }

        if(!deviceName)
            deviceName = 'Unknown';

        let displayName = this.code;

        this.name = {
            model: ua.device.model,
            os: ua.os.name,
            browser: ua.browser.name,
            type: ua.device.type,
            deviceName,
            displayName
        };
    }

    getInfo() {
        return {
            id: this.id,
            name: this.name,
            rtcSupported: this.rtcSupported
        }
    }

}

const server = new SnapdropServer(process.env.PORT || 3000);