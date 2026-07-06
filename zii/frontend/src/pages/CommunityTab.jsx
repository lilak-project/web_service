import { useEffect, useState } from 'react'
import { Community } from 'lilak-ui'
import { get } from '../api'
import { communityApi } from '../community_api'

// Built-in community/chat tab (kit <Community> + this service's backend module).
export default function CommunityTab({ onOpenFiles }) {
  const [role, setRole] = useState('user')
  useEffect(() => { get('/api/whoami').then((u) => setRole(u.role || 'user')).catch(() => {}) }, [])
  return (
    <div style={{ height: '100%', boxSizing: 'border-box', padding: 12 }}>
      <Community api={communityApi} role={role} onOpenFiles={onOpenFiles} storageKey="zii"
        features={{ attachments: true, questions: true, anon: true, polls: true, mentions: true, moderation: true }} />
    </div>
  )
}
