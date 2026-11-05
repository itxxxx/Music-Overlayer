// Demo from 21st.dev for the original <AudioPlayer /> component, which plays its own audio file.
// The widget doesn't render it: <NowPlayingCard /> is the adapted version that controls music
// already playing in other apps. This app's content security policy only allows local media,
// so point `src` and `cover` at files in the project if you render this demo here.
import AudioPlayer from "@/components/ui/audio-player"

const AudioPlayerDemo = () => {
    return(
          <AudioPlayer
    src="https://ui.webmakers.studio/audio/ncs.mp3"
    cover="https://cdn.21st.dev/assets/mirror/96/961fb12099ef654125e178d3ee23bef8dc43cbbe07f327ca79042f8609c7d867.jpg"
    title="NEFFEX & TOKYO MACHINE"
  />
    )
}

export {AudioPlayerDemo}
