# Chess Scan

Chess board scanner and position editor. Upload an image of a chess board to detect the position, or manually edit positions using drag-and-drop.

## Features

- Image based board scanning using computer vision (Roboflow API)
- Interactive board editor 
- FEN string generation and export
- Board manipulation (flip, swap colors)
- Castling rights, en passant, turn controls
- Direct links to analyze positions on Lichess and Chess.com

## Setup

### Prerequisites

- Node.js v16 or higher
- npm or yarn

### Installation

1. Install dependencies:
```bash
npm install
```

2. Create a `.env` file in the root directory:
```
VITE_ROBOFLOW_API_KEY=your_api_key_here
```

3. Start the development server:
```bash
npm run dev
```

4. Open http://localhost:5173 in your browser

## Build

```bash
npm run build
```

## Tech Stack

- React + Vite
- chess.js
- react-chessboard
- Tailwind CSS
- Roboflow API