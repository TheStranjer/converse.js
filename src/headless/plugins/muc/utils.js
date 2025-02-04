import isObject from 'lodash-es/isObject';
import log from "@converse/headless/log.js";
import { ROLES } from '@converse/headless/plugins/muc/index.js';
import { _converse, api, converse } from '@converse/headless/core.js';
import { getMEPActivities } from '@converse/headless/plugins/muc/parsers.js';
import { safeSave } from '@converse/headless/utils/core.js';

const { Strophe, sizzle, u } = converse.env;

/**
 * Given an occupant model, see which roles may be assigned to that user.
 * @param { Model } occupant
 * @returns { ('moderator', 'participant', 'visitor')[] } - An array of assignable roles
 */
export function getAssignableRoles (occupant) {
    let disabled = api.settings.get('modtools_disable_assign');
    if (!Array.isArray(disabled)) {
        disabled = disabled ? ROLES : [];
    }
    if (occupant.get('role') === 'moderator') {
        return ROLES.filter(r => !disabled.includes(r));
    } else {
        return [];
    }
}

export function registerDirectInvitationHandler () {
    _converse.connection.addHandler(
        message => {
            _converse.onDirectMUCInvitation(message);
            return true;
        },
        'jabber:x:conference',
        'message'
    );
}

export function disconnectChatRooms () {
    /* When disconnecting, mark all groupchats as
     * disconnected, so that they will be properly entered again
     * when fetched from session storage.
     */
    return _converse.chatboxes
        .filter(m => m.get('type') === _converse.CHATROOMS_TYPE)
        .forEach(m => m.session.save({ 'connection_status': converse.ROOMSTATUS.DISCONNECTED }));
}

export async function onWindowStateChanged (data) {
    if (data.state === 'visible' && api.connection.connected()) {
        const rooms = await api.rooms.get();
        rooms.forEach(room => room.rejoinIfNecessary());
    }
}

export async function routeToRoom (jid) {
    if (!u.isValidMUCJID(jid)) {
        return log.warn(`invalid jid "${jid}" provided in url fragment`);
    }
    await api.waitUntil('roomsAutoJoined');
    if (api.settings.get('allow_bookmarks')) {
        await api.waitUntil('bookmarksInitialized');
    }
    api.rooms.open(jid);
}

/* Opens a groupchat, making sure that certain attributes
 * are correct, for example that the "type" is set to
 * "chatroom".
 */
export async function openChatRoom (jid, settings) {
    settings.type = _converse.CHATROOMS_TYPE;
    settings.id = jid;
    const chatbox = await api.rooms.get(jid, settings, true);
    chatbox.maybeShow(true);
    return chatbox;
}


/**
 * A direct MUC invitation to join a groupchat has been received
 * See XEP-0249: Direct MUC invitations.
 * @private
 * @method _converse.ChatRoom#onDirectMUCInvitation
 * @param { XMLElement } message - The message stanza containing the invitation.
 */
export async function onDirectMUCInvitation (message) {
    const { __ } = _converse;
    const x_el = sizzle('x[xmlns="jabber:x:conference"]', message).pop(),
        from = Strophe.getBareJidFromJid(message.getAttribute('from')),
        room_jid = x_el.getAttribute('jid'),
        reason = x_el.getAttribute('reason');

    let result;
    if (api.settings.get('auto_join_on_invite')) {
        result = true;
    } else {
        // Invite request might come from someone not your roster list
        let contact = _converse.roster.get(from);
        contact = contact ? contact.getDisplayName() : from;
        if (!reason) {
            result = confirm(__('%1$s has invited you to join a groupchat: %2$s', contact, room_jid));
        } else {
            result = confirm(
                __(
                    '%1$s has invited you to join a groupchat: %2$s, and left the following reason: "%3$s"',
                    contact,
                    room_jid,
                    reason
                )
            );
        }
    }
    if (result === true) {
        const chatroom = await openChatRoom(room_jid, { 'password': x_el.getAttribute('password') });
        if (chatroom.session.get('connection_status') === converse.ROOMSTATUS.DISCONNECTED) {
            _converse.chatboxes.get(room_jid).rejoin();
        }
    }
}

export function getDefaultMUCNickname () {
    // XXX: if anything changes here, update the docs for the
    // locked_muc_nickname setting.
    if (!_converse.xmppstatus) {
        throw new Error(
            "Can't call _converse.getDefaultMUCNickname before the statusInitialized has been fired."
        );
    }
    const nick = _converse.xmppstatus.getNickname();
    if (nick) {
        return nick;
    } else if (api.settings.get('muc_nickname_from_jid')) {
        return Strophe.unescapeNode(Strophe.getNodeFromJid(_converse.bare_jid));
    }
}

/**
 * Determines info message visibility based on
 * muc_show_info_messages configuration setting
 * @param {*} code
 * @memberOf _converse
 */
export function isInfoVisible (code) {
    const info_messages = api.settings.get('muc_show_info_messages');
    if (info_messages.includes(code)) {
        return true;
    }
    return false;
}


/* Automatically join groupchats, based on the
 * "auto_join_rooms" configuration setting, which is an array
 * of strings (groupchat JIDs) or objects (with groupchat JID and other settings).
 */
export async function autoJoinRooms () {
    await Promise.all(
        api.settings.get('auto_join_rooms').map(muc => {
            if (typeof muc === 'string') {
                if (_converse.chatboxes.where({ 'jid': muc }).length) {
                    return Promise.resolve();
                }
                return api.rooms.open(muc);
            } else if (isObject(muc)) {
                return api.rooms.open(muc.jid, { ...muc });
            } else {
                log.error('Invalid muc criteria specified for "auto_join_rooms"');
                return Promise.resolve();
            }
        })
    );
    /**
     * Triggered once any rooms that have been configured to be automatically joined,
     * specified via the _`auto_join_rooms` setting, have been entered.
     * @event _converse#roomsAutoJoined
     * @example _converse.api.listen.on('roomsAutoJoined', () => { ... });
     * @example _converse.api.waitUntil('roomsAutoJoined').then(() => { ... });
     */
    api.trigger('roomsAutoJoined');
}


/**
 * Given a stanza, look for XEP-0316 Room Notifications and create info
 * messages for them.
 * @param { XMLElement } stanza
 */
async function handleMEPNotification (stanza) {
    const from = stanza.getAttribute('from');
    if (u.isSameBareJID(from, _converse.bare_jid)) {
        return;
    }
    const room = await api.rooms.get(from);
    if (!room) {
        log.warn(`Received a MEP message for a non-existent room: ${from}`);
        return;
    }
    const msgid = stanza.getAttribute('id');
    if (room.messages.findWhere({ msgid })) {
        // We already handled this stanza before
        return;
    }
    getMEPActivities(stanza, room).forEach(attrs => {
        room.createMessage(attrs);
        api.trigger('message', { stanza, attrs, 'chatbox': room });
    });
}


function checkIfMEP (message) {
    try {
        if (sizzle(`event[xmlns="${Strophe.NS.PUBSUB}#event"]`, message).length) {
            handleMEPNotification(message);
        }
    } catch (e) {
        log.error(e.message);
    }
    return true;
}


export function registerPEPPushHandler () {
    // Add a handler for devices pushed from other connected clients
    _converse.connection.addHandler(checkIfMEP, null, 'message', 'headline');

    // XXX: This is a hack. Prosody's MUC MAM doesn't allow for quering
    // non-groupchat messages. So even though they might be archived, they
    // don't get returned on query. To bypass this, some MEP messages are sent
    // with type="groupchat".
    // https://hg.prosody.im/prosody-modules/rev/da9469e68dee
    _converse.connection.addHandler(checkIfMEP, null, 'message', 'groupchat');
}

export function onAddClientFeatures () {
    if (api.settings.get('allow_muc')) {
        api.disco.own.features.add(Strophe.NS.MUC);
    }
    if (api.settings.get('allow_muc_invitations')) {
        api.disco.own.features.add('jabber:x:conference'); // Invites
    }
}

export function onBeforeTearDown () {
    _converse.chatboxes
        .where({ 'type': _converse.CHATROOMS_TYPE })
        .forEach(muc => safeSave(muc.session, { 'connection_status': converse.ROOMSTATUS.DISCONNECTED }));
}

export function onStatusInitialized () {
    window.addEventListener(_converse.unloadevent, () => {
        const using_websocket = api.connection.isType('websocket');
        if (
            using_websocket &&
            (!api.settings.get('enable_smacks') || !_converse.session.get('smacks_stream_id'))
        ) {
            // For non-SMACKS websocket connections, or non-resumeable
            // connections, we disconnect all chatrooms when the page unloads.
            // See issue #1111
            disconnectChatRooms();
        }
    });
}

export function onBeforeResourceBinding () {
    _converse.connection.addHandler(
        stanza => {
            const muc_jid = Strophe.getBareJidFromJid(stanza.getAttribute('from'));
            if (!_converse.chatboxes.get(muc_jid)) {
                api.waitUntil('chatBoxesFetched').then(async () => {
                    const muc = _converse.chatboxes.get(muc_jid);
                    if (muc) {
                        await muc.initialized;
                        muc.message_handler.run(stanza);
                    }
                });
            }
            return true;
        },
        null,
        'message',
        'groupchat'
    );
}


Object.assign(_converse, { getAssignableRoles });
