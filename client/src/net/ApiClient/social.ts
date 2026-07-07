// Social: friends (S6-1) + private chat (S6-2). Send/fetch via REST; real-time events via gateway push (NetSession).
import { type Constructor, type ApiClientBaseCtor } from './base';
import type {
  FriendView,
  FriendRequestView,
  SocialBadges,
  ProfileView,
  ConversationView,
  ChatMessageView,
} from './types';

export interface SocialApi {
  getFriends(): Promise<FriendView[]>;
  getFriendRequests(): Promise<{ incoming: FriendRequestView[]; outgoing: FriendRequestView[] }>;
  getSocialBadges(): Promise<SocialBadges>;
  searchFriend(publicId: string): Promise<ProfileView>;
  requestFriend(publicId: string, message?: string): Promise<string>;
  respondFriend(requestId: string, accept: boolean): Promise<void>;
  removeFriend(publicId: string): Promise<void>;
  blockUser(publicId: string): Promise<void>;
  unblockUser(publicId: string): Promise<void>;
  getConversations(): Promise<ConversationView[]>;
  getMessages(convId: string, before?: number, limit?: number): Promise<ChatMessageView[]>;
  sendChat(toPublicId: string, body: string): Promise<{ messageId: string; ts: number }>;
  readChat(convId: string): Promise<void>;
}

export function SocialMixin<TBase extends ApiClientBaseCtor>(Base: TBase): TBase & Constructor<SocialApi> {
  return class extends Base {
    // ── Social: friends (S6-1, requires login token). Send/fetch via REST; real-time events via gateway push (NetSession). ──
    /** Friend list (includes online status). */
    async getFriends(): Promise<FriendView[]> {
      const data = await this.request<{ friends: FriendView[] }>('GET', '/friends');
      return data.friends;
    }

    /** Pending friend requests (received + sent). */
    async getFriendRequests(): Promise<{ incoming: FriendRequestView[]; outgoing: FriendRequestView[] }> {
      return this.request<{ incoming: FriendRequestView[]; outgoing: FriendRequestView[] }>(
        'GET',
        '/friends/requests',
      );
    }

    /** Offline badge aggregate (SOC8): fetched once after login for total unread badge counts; subsequently updated incrementally via social push events. */
    async getSocialBadges(): Promise<SocialBadges> {
      return this.request<SocialBadges>('GET', '/social/badges');
    }

    /** Search for a player by 9-digit public id. Not found → ApiError('NOT_FOUND') (404). */
    async searchFriend(publicId: string): Promise<ProfileView> {
      const data = await this.post<{ profile: ProfileView }>('/friends/search', { publicId });
      return data.profile;
    }

    /**
     * Send a friend request. Already friends → ApiError('ALREADY_FRIEND'); cap exceeded → 'FRIEND_CAP_REACHED';
     * blocked by target → 'BLOCKED'; target not found → 'NOT_FOUND'.
     */
    async requestFriend(publicId: string, message?: string): Promise<string> {
      const data = await this.post<{ requestId: string }>('/friends/request', {
        publicId,
        ...(message ? { message } : {}),
      });
      return data.requestId;
    }

    /** Accept / decline a friend request (accept=true → creates bidirectional edge). */
    async respondFriend(requestId: string, accept: boolean): Promise<void> {
      await this.post<{ ok: boolean }>('/friends/respond', { requestId, accept });
    }

    /** Remove a friend (bidirectional). */
    async removeFriend(publicId: string): Promise<void> {
      await this.request<{ ok: boolean }>('DELETE', `/friends/${encodeURIComponent(publicId)}`);
    }

    /** Block a user (removes friendship + blocks friend requests / private messages). */
    async blockUser(publicId: string): Promise<void> {
      await this.post<{ ok: boolean }>('/friends/block', { publicId });
    }

    /** Unblock a user. */
    async unblockUser(publicId: string): Promise<void> {
      await this.request<{ ok: boolean }>('DELETE', `/friends/block/${encodeURIComponent(publicId)}`);
    }

    // ── Social: private chat (S6-2, requires login token). Send via REST; receive messages via gateway push (NetSession). ──
    /** Conversation list (includes per-conversation unread count + last message snippet). */
    async getConversations(): Promise<ConversationView[]> {
      const data = await this.request<{ conversations: ConversationView[] }>('GET', '/chat/conversations');
      return data.conversations;
    }

    /** Fetch conversation history (paginated, reverse chronological). `before` = cursor (epoch ms, retrieves messages older than this). */
    async getMessages(convId: string, before?: number, limit = 30): Promise<ChatMessageView[]> {
      const qs = `?limit=${limit}${before !== undefined ? `&before=${before}` : ''}`;
      const data = await this.request<{ messages: ChatMessageView[] }>(
        'GET',
        `/chat/${encodeURIComponent(convId)}/messages${qs}`,
      );
      return data.messages;
    }

    /** Send a private chat message. Not friends → ApiError('NOT_FRIEND'); blocked → 'BLOCKED'; rate limited → 'RATE_LIMITED' (429). */
    async sendChat(toPublicId: string, body: string): Promise<{ messageId: string; ts: number }> {
      return this.post<{ messageId: string; ts: number }>('/chat/send', { toPublicId, body });
    }

    /** Mark a conversation as read (clears unread count). */
    async readChat(convId: string): Promise<void> {
      await this.post<{ ok: boolean }>('/chat/read', { convId });
    }
  };
}
