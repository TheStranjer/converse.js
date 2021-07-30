import 'plugins/chatview/heading.js';
import 'plugins/chatview/bottom-panel.js';
import BaseChatView from 'shared/chat/baseview.js';
import tpl_chat from './templates/chat.js';
import { __ } from 'i18n';
import { _converse, api } from '@converse/headless/core';

/**
 * The view of an open/ongoing chat conversation.
 * @class
 * @namespace _converse.ChatBoxView
 * @memberOf _converse
 */
export default class ChatView extends BaseChatView {
    length = 200

    connectedCallback () {
        super.connectedCallback();
        this.initialize();
    }

    async initialize() {
        _converse.chatboxviews.add(this.jid, this);
        this.model = _converse.chatboxes.get(this.jid);
        this.listenTo(_converse, 'windowStateChanged', this.onWindowStateChanged);
        this.listenTo(this.model, 'change:hidden', () => !this.model.get('hidden') && this.afterShown());
        this.listenTo(this.model, 'change:show_help_messages', this.requestUpdate);

        await this.model.messages.fetched;
        !this.model.get('hidden') && this.afterShown()
        /**
         * Triggered once the {@link _converse.ChatBoxView} has been initialized
         * @event _converse#chatBoxViewInitialized
         * @type { _converse.HeadlinesBoxView }
         * @example _converse.api.listen.on('chatBoxViewInitialized', view => { ... });
         */
        api.trigger('chatBoxViewInitialized', this);
    }

    render () {
        return tpl_chat(Object.assign({
            'model': this.model,
            'help_messages': this.getHelpMessages(),
            'show_help_messages': this.model.get('show_help_messages'),
        }, this.model.toJSON()));
    }

    onWindowStateChanged ({ state }) {
        if (state === 'visible') {
            this.model.setChatState(_converse.ACTIVE, {'silent': true});
            if (!this.model.isHidden() && this.model.get('num_unread')) {
                this.model.clearUnreadMsgCounter();
            }
        } else if (state === 'hidden') {
            this.model.setChatState(_converse.INACTIVE, {'silent': true});
            this.model.sendChatState();
        }
    }

    getHelpMessages () { // eslint-disable-line class-methods-use-this
        return [
            `<strong>/clear</strong>: ${__('Remove messages')}`,
            `<strong>/close</strong>: ${__('Close this chat')}`,
            `<strong>/me</strong>: ${__('Write in the third person')}`,
            `<strong>/help</strong>: ${__('Show this menu')}`
        ];
    }

    showControlBox () { // eslint-disable-line class-methods-use-this
        // Used in mobile view, to navigate back to the controlbox
        _converse.chatboxviews.get('controlbox')?.show();
    }

    afterShown () {
        this.model.setChatState(_converse.ACTIVE);
        this.model.clearUnreadMsgCounter();
        this.maybeFocus();
    }
}

api.elements.define('converse-chat', ChatView);
