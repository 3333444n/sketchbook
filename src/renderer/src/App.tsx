import { Excalidraw } from '@excalidraw/excalidraw'
import '@excalidraw/excalidraw/index.css'

function App(): React.JSX.Element {
  return (
    <div style={{ position: 'fixed', inset: 0 }}>
      <Excalidraw />
    </div>
  )
}

export default App
