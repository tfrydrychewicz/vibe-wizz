import { createApp } from 'vue'
import './style.css'
import App from './App.vue'
import MeetingPromptApp from './MeetingPromptApp.vue'

const params = new URLSearchParams(window.location.search)
const root = params.get('mode') === 'meeting-prompt' ? MeetingPromptApp : App
createApp(root).mount('#app')
