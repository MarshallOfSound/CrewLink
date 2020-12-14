import React, { useContext, useEffect, useMemo, useRef, useState } from 'react';
import io, { Socket } from 'socket.io-client';
import Avatar from './Avatar';
import { GameStateContext, SettingsContext } from './contexts';
import { AmongUsState, GameState, Player } from '../common/AmongUsState';
import Peer from 'simple-peer';
import { ipcRenderer } from 'electron';
import VAD from './vad';
import { ISettings } from '../common/ISettings';
import { IpcMessages, IpcRendererMessages } from '../common/ipc-messages';
import { IS_SIDECAR_MODE } from '../common/constants';

export interface ExtendedAudioElement extends HTMLAudioElement {
	setSinkId: (sinkId: string) => Promise<void>;
}

interface PeerConnections {
	[peer: string]: Peer.Instance;
}

interface AudioElements {
	[peer: string]: {
		element: HTMLAudioElement;
		gain: GainNode;
		pan: PannerNode;
	};
}

interface SocketIdMap {
	[socketId: string]: number;
}

interface ConnectionStuff {
	socket: typeof Socket;
	stream?: MediaStream;
	pushToTalk: boolean;
	deafened: boolean;
}

interface OtherTalking {
	[playerId: number]: boolean; // isTalking
}

interface OtherDead {
	[playerId: number]: boolean; // isTalking
}

function calculateVoiceAudio(state: AmongUsState, settings: ISettings, me: Player, other: Player, gain: GainNode, pan: PannerNode): void {
	const audioContext = pan.context;
	pan.positionZ.setValueAtTime(-0.5, audioContext.currentTime);
	let panPos = [
		(other.x - me.x),
		(other.y - me.y)
	];
	if (state.gameState === GameState.DISCUSSION || (state.gameState === GameState.LOBBY && !settings.enableSpatialAudio)) {
		panPos = [0, 0];
	}
	if (isNaN(panPos[0])) panPos[0] = 999;
	if (isNaN(panPos[1])) panPos[1] = 999;
	panPos[0] = Math.min(999, Math.max(-999, panPos[0]));
	panPos[1] = Math.min(999, Math.max(-999, panPos[1]));
	if (other.inVent) {
		gain.gain.value = 0;
		return;
	}
	if (me.isDead && other.isDead) {
		gain.gain.value = 1;
		pan.positionX.setValueAtTime(panPos[0], audioContext.currentTime);
		pan.positionY.setValueAtTime(panPos[1], audioContext.currentTime);
		return;
	}
	if (!me.isDead && other.isDead) {
		gain.gain.value = 0;
		return;
	}
	if (state.gameState === GameState.LOBBY || state.gameState === GameState.DISCUSSION) {
		gain.gain.value = 1;
		pan.positionX.setValueAtTime(panPos[0], audioContext.currentTime);
		pan.positionY.setValueAtTime(panPos[1], audioContext.currentTime);
	} else if (state.gameState === GameState.TASKS) {
		gain.gain.value = 1;
		pan.positionX.setValueAtTime(panPos[0], audioContext.currentTime);
		pan.positionY.setValueAtTime(panPos[1], audioContext.currentTime);
	} else {
		gain.gain.value = 0;
	}
	if (gain.gain.value === 1 && Math.sqrt(Math.pow(panPos[0], 2) + Math.pow(panPos[1], 2)) > 7) {
		gain.gain.value = 0;
	}
}


const Voice: React.FC<{ setGameState: (newState: AmongUsState) => void }> = function ({ setGameState }) {
	const [settings] = useContext(SettingsContext);
	const settingsRef = useRef<ISettings>(settings);
	const gameState = useContext(GameStateContext) || {};
	const [shareGameState, setShareGameState] = useState(false);
	let { lobbyCode: displayedLobbyCode } = gameState;
	if (displayedLobbyCode !== 'MENU' && settings.hideCode) displayedLobbyCode = 'LOBBY';
	if (!gameState.lobbyCode && IS_SIDECAR_MODE) {
		displayedLobbyCode = 'SIDECAR';
	}
	const [talking, setTalking] = useState(false);
	const [socketPlayerIds, setSocketPlayerIds] = useState<SocketIdMap>({});
	const [connect, setConnect] = useState<({ connect: (lobbyCode: string, playerId: number) => void }) | null>(null);
	const [otherTalking, setOtherTalking] = useState<OtherTalking>({});
	const [otherDead, setOtherDead] = useState<OtherDead>({});
	const audioElements = useRef<AudioElements>({});

	const [deafenedState, setDeafened] = useState(false);
	const [connected, setConnected] = useState(false);

	// Handle pushToTalk, if set
	useEffect(() => {
		if (!connectionStuff.current.stream) return;
		connectionStuff.current.stream.getAudioTracks()[0].enabled = !settings.pushToTalk;
		connectionStuff.current.pushToTalk = settings.pushToTalk;
	}, [settings.pushToTalk]);

	// Add settings to settingsRef
	useEffect(() => {
		settingsRef.current = settings;
	}, [settings]);

	// Set dead player data
	useEffect(() => {
		if (gameState.gameState === GameState.LOBBY) {
			setOtherDead({});
		} else if (gameState.gameState !== GameState.TASKS) {
			if (!gameState.players) return;
			setOtherDead(old => {
				for (const player of gameState.players) {
					old[player.id] = player.isDead || player.disconnected;
				}
				return { ...old };
			});
		}
	}, [gameState.gameState]);

	const connectionStuff = useRef<Partial<ConnectionStuff>>({
		pushToTalk: settings.pushToTalk,
		deafened: false,
	});
	const [sidecarPlayerId, setSidecarPlayerId] = useState<number | null>(null);
	const [sidecarLobbyCode, setSidecarLobbyCode] = useState<string | null>(null);

	// BIG ASS BLOB - Handle audio
	useEffect(() => {
		// Connect to voice relay server
		connectionStuff.current.socket = io(settings.serverURL, { transports: ['websocket'] });
		const { socket } = connectionStuff.current;

		socket.on('connect', () => {
			setConnected(true);
		});
		socket.on('disconnect', () => {
			setConnected(false);
		});

		// Initialize variables
		let audioListener: {
			connect: () => void;
			destroy: () => void;
		};
		const audio = {
			deviceId: undefined as unknown as string,
			autoGainControl: false,
			channelCount: 2,
			echoCancellation: false,
			latency: 0,
			noiseSuppression: false,
			sampleRate: 48000,
			sampleSize: 16,
			googEchoCancellation: false,
			googAutoGainControl: false,
			googAutoGainControl2: false,
			googNoiseSuppression: false,
			googHighpassFilter: false,
			googTypingNoiseDetection: false
		};

		// Get microphone settings
		if (settings.microphone.toLowerCase() !== 'default')
			audio.deviceId = settings.microphone;

		navigator.getUserMedia({ video: false, audio }, async (stream) => {
			connectionStuff.current.stream = stream;

			stream.getAudioTracks()[0].enabled = !settings.pushToTalk;

			ipcRenderer.on(IpcRendererMessages.TOGGLE_DEAFEN, () => {
				connectionStuff.current.deafened = !connectionStuff.current.deafened;
				stream.getAudioTracks()[0].enabled = !connectionStuff.current.deafened;
				setDeafened(connectionStuff.current.deafened);
			});
			ipcRenderer.on(IpcRendererMessages.PUSH_TO_TALK, (_: unknown, pressing: boolean) => {
				if (!connectionStuff.current.pushToTalk) return;
				if (!connectionStuff.current.deafened) {
					stream.getAudioTracks()[0].enabled = pressing;
				}
			});

			const ac = new AudioContext();
			ac.createMediaStreamSource(stream);
			audioListener = VAD(ac, ac.createMediaStreamSource(stream), undefined, {
				onVoiceStart: () => setTalking(true),
				onVoiceStop: () => setTalking(false),
				noiseCaptureDuration: 1,
				stereo: false
			});

			const peerConnections: PeerConnections = {};
			audioElements.current = {};

			const connect = (lobbyCode: string, playerId: number) => {
				console.log('Connect called', lobbyCode, playerId);
				socket.emit('leave');
				Object.keys(peerConnections).forEach(k => {
					disconnectPeer(k);
				});
				setSocketPlayerIds({});

				if (lobbyCode === 'MENU') return;

				function disconnectPeer(peer: string) {
					const connection = peerConnections[peer];
					if (!connection) {
						return;
					}
					connection.destroy();
					delete peerConnections[peer];
					if (audioElements.current[peer]) {
						document.body.removeChild(audioElements.current[peer].element);
						audioElements.current[peer].pan.disconnect();
						audioElements.current[peer].gain.disconnect();
						delete audioElements.current[peer];
					}
				}

				socket.emit('join', lobbyCode, playerId);
				// In sidecar mode we need to tell the socket we are expecting
				// gamestate events.  In theory sending this message will either
				// result in "gamestate" events or a "no-gamestate" event that indicates
				// the game does not currently have a host for our sidecar client
				if (IS_SIDECAR_MODE) {
					socket.emit('sidecar');
				}
			};
			setConnect({ connect });
			function createPeerConnection(peer: string, initiator: boolean) {
				const connection = new Peer({
					stream, initiator, config: {
						iceServers: [
							{
								'urls': 'stun:stun.l.google.com:19302'
							}
						]
					}
				});
				peerConnections[peer] = connection;

				connection.on('stream', (stream: MediaStream) => {
					const audio = document.createElement('audio') as ExtendedAudioElement;
					document.body.appendChild(audio);
					audio.srcObject = stream;
					if (settings.speaker.toLowerCase() !== 'default')
						audio.setSinkId(settings.speaker);

					const context = new AudioContext();
					const source = context.createMediaStreamSource(stream);
					const gain = context.createGain();
					const pan = context.createPanner();
					pan.refDistance = 0.1;
					pan.panningModel = 'equalpower';
					pan.distanceModel = 'linear';
					pan.maxDistance = 2.66 * 2;
					pan.rolloffFactor = 1;

					source.connect(pan);
					pan.connect(gain);
					// Source -> pan -> gain -> VAD -> destination
					VAD(context, gain, context.destination, {
						onVoiceStart: () => setTalking(true),
						onVoiceStop: () => setTalking(false),
						stereo: settingsRef.current.enableSpatialAudio
					});

					const setTalking = (talking: boolean) => {
						setSocketPlayerIds(socketPlayerIds => {
							setOtherTalking(old => ({
								...old,
								[socketPlayerIds[peer]]: talking && gain.gain.value > 0
							}));
							return socketPlayerIds;
						});
					};
					audioElements.current[peer] = { element: audio, gain, pan };
				});
				connection.on('signal', (data) => {
					socket.emit('signal', {
						data,
						to: peer
					});
				});
				connection.on('error', console.error.bind(console, 'bad connection'));
				return connection;
			}
			socket.on('join', async (peer: string, playerId: number) => {
				createPeerConnection(peer, true);
				setSocketPlayerIds(old => ({ ...old, [peer]: playerId }));
			});
			socket.on('signal', ({ data, from }: { data: Peer.SignalData, from: string }) => {
				let connection: Peer.Instance;
				if (peerConnections[from]) {
					connection = peerConnections[from];
				} else {
					connection = createPeerConnection(from, false);
				}
				connection.signal(data);
			});
			socket.on('setId', (socketId: string, id: number) => {
				setSocketPlayerIds(old => ({ ...old, [socketId]: id }));
			});
			socket.on('setIds', (ids: SocketIdMap) => {
				setSocketPlayerIds(ids);
			});
			// When running in sidecar mode, we listen to the gamestate message
			// coming over the socket as that is going to be a helpful third party
			// proxying game state information to our sidecar client
			if (IS_SIDECAR_MODE) {
				socket.on('gamestate', (newGameState: AmongUsState) => {
					newGameState.players = newGameState.players.map(p => ({
						...p,
						isLocal: p.id === sidecarPlayerId,
					}));
					setGameState(newGameState);
				});
				socket.on('no-gamestate', () => {
					ipcRenderer.send(IpcMessages.SHOW_ERROR_DIALOG, {
						title: 'No Host Detected',
						content: 'Your sidecar client requires at least one "host" client to be already connected in the lobby.  Please ensure one of your lobby is running the full CrewLink client in this lobby and then restart CrewLink SideCar',
					});
				});
			}
			socket.on('share-gamestate', () => {
				setShareGameState(true);
			})
		}, (error) => {
			console.error(error);
			ipcRenderer.send(IpcMessages.SHOW_ERROR_DIALOG, {
				title: 'Error',
				content: 'Couldn\'t connect to your microphone:\n' + error
			});
		});

		return () => {
			connectionStuff.current.socket?.close();
			audioListener.destroy();
		};
	}, [sidecarPlayerId]);


	const myPlayer = useMemo(() => {
		if (!gameState || !gameState.players) {
			return undefined;
		} else {
			return gameState.players.find((p) => p.isLocal);
		}
	}, [gameState.players]);
	const myPlayerId = useMemo(() => {
		if (IS_SIDECAR_MODE) {
			if (!myPlayer && sidecarPlayerId !== null) {
				return sidecarPlayerId;
			}
		}
		return myPlayer?.id;
	}, [myPlayer, sidecarPlayerId]);

	const otherPlayers = useMemo(() => {
		let otherPlayers: Player[];
		if (!gameState || !gameState.players || gameState.lobbyCode === 'MENU' || !myPlayer) return [];
		else otherPlayers = gameState.players.filter(p => !p.isLocal);

		const playerSocketIds: {
			[index: number]: string
		} = {};
		for (const k of Object.keys(socketPlayerIds)) {
			playerSocketIds[socketPlayerIds[k]] = k;
		}
		for (const player of otherPlayers) {
			const audio = audioElements.current[playerSocketIds[player.id]];
			if (audio) {
				calculateVoiceAudio(gameState, settingsRef.current, myPlayer, player, audio.gain, audio.pan);
				if (connectionStuff.current.deafened) {
					audio.gain.gain.value = 0;
				}
			}
		}

		return otherPlayers;
	}, [gameState]);

	// Connect to P2P negotiator, when lobby and connect code change
	useEffect(() => {
		if (connect?.connect && (sidecarLobbyCode || gameState.lobbyCode) && myPlayerId !== undefined) {
			connect.connect(sidecarLobbyCode || gameState.lobbyCode, myPlayerId);
		}
	}, [connect?.connect, sidecarLobbyCode || gameState?.lobbyCode]);

	// Connect to P2P negotiator, when game mode change
	useEffect(() => {
		if (connect?.connect && (sidecarLobbyCode || gameState.lobbyCode) && myPlayerId !== undefined && gameState.gameState === GameState.LOBBY && (gameState.oldGameState === GameState.DISCUSSION || gameState.oldGameState === GameState.TASKS)) {
			connect.connect(sidecarLobbyCode || gameState.lobbyCode, myPlayerId);
		}
	}, [gameState.gameState]);

	// Emit player id to socket
	useEffect(() => {
		if (connectionStuff.current.socket && myPlayerId !== undefined) {
			connectionStuff.current.socket.emit('id', myPlayerId);
		}
	}, [myPlayerId]);

	useEffect(() => {
		if (connectionStuff.current.socket && shareGameState && myPlayerId === 0) {
			connectionStuff.current.socket.emit('gamestate', gameState);
		}
	}, [shareGameState, gameState]);

	return (
		<div className="root">
			<div className="top">
				{myPlayer &&
					<Avatar deafened={deafenedState} player={myPlayer} borderColor={connected ? '#2ecc71' : '#c0392b'} talking={talking} isAlive={!myPlayer.isDead} size={100} />
					// <div className="avatar" style={{ borderColor: talking ? '#2ecc71' : 'transparent' }}>
					// 	<Canvas src={alive} color={playerColors[myPlayer.colorId][0]} shadow={playerColors[myPlayer.colorId][1]} />
					// </div>
				}
				<div className="right">
					{myPlayer && gameState?.gameState !== GameState.MENU &&
						<span className="username">
							{myPlayer.name}
						</span>
					}
					{(gameState.lobbyCode || IS_SIDECAR_MODE) &&
						<span className="code" style={{ background: gameState.lobbyCode === 'MENU' ? 'transparent' : '#3e4346' }}>
							{displayedLobbyCode}
						</span>
					}
				</div>
			</div>
			<hr />
			{
				displayedLobbyCode === 'SIDECAR' && IS_SIDECAR_MODE ?
				(
					<div className="sidecar-details">
						<div className="form-control m">
							<label>Lobby Code</label>
							<input spellCheck={false} type="text" defaultValue={sidecarLobbyCode || ''} onKeyDown={e => e.which === 13 ? setSidecarLobbyCode(e.currentTarget.value) : null} />
						</div>
						<div className="form-control m">
							<label>Player Identity</label>
							<input spellCheck={false} type="text" defaultValue={`${sidecarPlayerId || ''}`} onKeyDown={e => e.which === 13 ? setSidecarPlayerId(parseInt(e.currentTarget.value, 10)) : null} />
						</div>
					</div>
				) : null
			}
			<div className="otherplayers">
				{
					otherPlayers.map(player => {
						const connected = Object.values(socketPlayerIds).includes(player.id);
						return (
							<Avatar key={player.id} player={player}
								talking={!connected || otherTalking[player.id]}
								borderColor={connected ? '#2ecc71' : '#c0392b'}
								isAlive={!otherDead[player.id]}
								size={50} />
						);
					})
				}
			</div>
		</div>
	);
};

export default Voice;
