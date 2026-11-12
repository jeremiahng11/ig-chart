/* IG Charts — drawing tools engine.
 * Drawings are stored per market as {time, price} anchors, so they stay put across timeframes and reloads.
 * The host supplies coordinate conversion; this module owns hit-testing, editing, rendering and undo/redo.
 * Each tool builds a list of screen-space primitives per frame; rendering, culling and hit-testing work on those.
 */
(() => {
  const COLORS = ['#2962ff', '#f7b924', '#26a69a', '#ef5350', '#c77dff', '#4dd0e1', '#ff6d00', '#d1d4dc'];
  const FONT = '-apple-system, BlinkMacSystemFont, sans-serif';
  const FIB = [
    [0, '#787b86'], [0.236, '#f23645'], [0.382, '#ff9800'], [0.5, '#4caf50'], [0.618, '#089981'], [0.786, '#00bcd4'], [1, '#787b86'],
    [1.618, '#2962ff'], [2.618, '#f23645'],
  ];
  const PAL = ['#787b86', '#f23645', '#ff9800', '#4caf50', '#089981', '#00bcd4', '#2962ff', '#9c27b0', '#e91e63', '#f7b924', '#26a69a'];
  const fibColor = (lv, i) => { const f = FIB.find((x) => Math.abs(x[0] - lv) < 1e-9); return f ? f[1] : PAL[(i || 0) % PAL.length]; };
  const LV = {
    ret: [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1], retMore: [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1, 1.618, 2.618, 3.618, 4.236],
    ext: [0, 0.382, 0.5, 0.618, 1, 1.272, 1.618, 2, 2.618], extMore: [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1, 1.272, 1.618, 2, 2.618, 3.618, 4.236],
    fan: [0, 0.25, 0.382, 0.5, 0.618, 0.75, 1], fanMore: [0, 0.236, 0.25, 0.382, 0.5, 0.618, 0.75, 0.786, 1],
    time: [0, 0.382, 0.5, 0.618, 1, 1.382, 1.618, 2, 2.382, 2.618, 3], timeMore: [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1, 1.272, 1.382, 1.618, 2, 2.382, 2.618, 3, 3.618, 4.236],
    circ: [0.236, 0.382, 0.5, 0.618, 0.786, 1], circMore: [0.236, 0.382, 0.5, 0.618, 0.786, 1, 1.618, 2.618, 3.618],
    gann: [0, 0.25, 0.382, 0.5, 0.618, 0.75, 1],
    zones: [0, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233],
  };
  const GROUPS = [
    { id: 'cursor', label: 'Cursors' }, { id: 'trend', label: 'Trend line tools' }, { id: 'fib', label: 'Gann and Fibonacci tools' },
    { id: 'patterns', label: 'Patterns' }, { id: 'forecast', label: 'Forecasting and measurement tools' },
    { id: 'shapes', label: 'Geometric shapes' }, { id: 'annotation', label: 'Annotation tools' },
  ];
  // n = anchor clicks needed (0 = freehand, 'multi' = until double-click / Enter). Toolbar flags: ext, stats, fill, levels, text, line:false.
  const t = (group, sub, label, n, color, icon, o) => ({ group, sub, label, n, color, icon, ...o });
  const BLUE = '#2962ff', FIBG = '#787b86', TEAL = '#26a69a', RED = '#ef5350', PURP = '#c77dff', ORNG = '#ff6d00', GREY = '#d1d4dc';
  const TOOLS = {
    eraser: t('cursor', 'Cursors', 'Eraser', 1, RED, 'M3 13l7-7 5 5-5 5H6zM8 8l5 5M6 16h10', { erase: true }),

    trend: t('trend', 'Lines', 'Trend line', 2, BLUE, 'M3.5 14.5l11-11', { ext: true, stats: true }),
    ray: t('trend', 'Lines', 'Ray', 2, BLUE, 'M3.5 14.5L17 1', { type: 'trend', props: { extR: true }, ext: true, stats: true }),
    infoline: t('trend', 'Lines', 'Info line', 2, BLUE, 'M2 15L12 5M10 12h6M10 15h6M13 9h3', { type: 'trend', props: { info: true }, ext: true }),
    extended: t('trend', 'Lines', 'Extended line', 2, BLUE, 'M1 17L17 1', { type: 'trend', props: { extL: true, extR: true }, ext: true, stats: true }),
    trendangle: t('trend', 'Lines', 'Trend angle', 2, BLUE, 'M2 15h14M2 15L14 4M8 15a6 6 0 00-1.6-4.1', { type: 'angle', ext: true }),
    hline: t('trend', 'Lines', 'Horizontal line', 1, '#f7b924', 'M1 9h16'),
    hray: t('trend', 'Lines', 'Horizontal ray', 1, '#f7b924', 'M5 9h12'),
    vline: t('trend', 'Lines', 'Vertical line', 1, BLUE, 'M9 1v16'),
    cross: t('trend', 'Lines', 'Cross line', 1, BLUE, 'M9 1v16M1 9h16'),
    channel: t('trend', 'Channels', 'Parallel channel', 3, BLUE, 'M2 11L12 3M6 15L16 7', { ext: true, fill: true }),
    regression: t('trend', 'Channels', 'Regression trend', 2, BLUE, 'M2 13L16 5M2 9L16 1M2 17L16 9', { ext: true, fill: true, bars: true }),
    flatchannel: t('trend', 'Channels', 'Flat top/bottom', 3, BLUE, 'M2 12L16 4M2 15h14', { fill: true }),
    disjoint: t('trend', 'Channels', 'Disjoint channel', 3, BLUE, 'M2 4l14 5M2 15l14-5', { fill: true }),
    pitchfork: t('trend', 'Pitchforks', 'Pitchfork', 3, '#f23645', 'M2 12l6-3M8 9l8-5M8 9h8M8 9l8 5', { fill: true, levels: true }),
    schiff: t('trend', 'Pitchforks', 'Schiff pitchfork', 3, '#f23645', 'M2 15v-4l6-2M8 9l8-6M8 9h8M8 9l8 6', { type: 'pitchfork', props: { variant: 'schiff' }, fill: true, levels: true }),
    modschiff: t('trend', 'Pitchforks', 'Modified Schiff pitchfork', 3, '#f23645', 'M5 6v6M5 9h3M8 9l8-6M8 9h8M8 9l8 6', { type: 'pitchfork', props: { variant: 'modschiff' }, fill: true, levels: true }),
    insidepf: t('trend', 'Pitchforks', 'Inside pitchfork', 3, '#f23645', 'M2 9h4M6 9l10-4M6 9h10M6 9l10 4M11 5v8', { type: 'pitchfork', props: { variant: 'inside' }, fill: true, levels: true }),

    fib: t('fib', 'Fibonacci', 'Fib retracement', 2, FIBG, 'M2 3h14M2 7h14M2 11h14M2 15h14M4 15L14 3', { ext: true, levels: true, line: false }),
    fibext: t('fib', 'Fibonacci', 'Trend-based fib extension', 3, FIBG, 'M2 15l4-8 4 5M8 3h8M8 7h8M10 11h6', { ext: true, levels: true }),
    fibchannel: t('fib', 'Fibonacci', 'Fib channel', 3, FIBG, 'M2 8l14-6M2 12l14-6M2 16l14-6', { ext: true, levels: true }),
    fibtime: t('fib', 'Fibonacci', 'Fib time zone', 2, FIBG, 'M2 2v14M4 2v14M7 2v14M12 2v14'),
    fibfan: t('fib', 'Fibonacci', 'Fib speed resistance fan', 2, FIBG, 'M2 16L16 2M2 16L16 7M2 16L16 11M2 16h14M2 16L7 2', { levels: true }),
    fibtimetrend: t('fib', 'Fibonacci', 'Trend-based fib time', 3, FIBG, 'M3 2v14M8 2v14M11 2v14M16 2v14M3 12l5-6 3 4', { levels: true }),
    fibcircles: t('fib', 'Fibonacci', 'Fib circles', 2, FIBG, 'M7 9a2 2 0 104 0 2 2 0 10-4 0M4 9a5 5 0 1010 0A5 5 0 104 9M1 9a8 8 0 1016 0A8 8 0 101 9', { levels: true }),
    fibspiral: t('fib', 'Fibonacci', 'Fib spiral', 2, FIBG, 'M9 9a1 1 0 011 1 2 2 0 01-2 2 3 3 0 01-3-3 5 5 0 015-5 8 8 0 018 8'),
    fibarcs: t('fib', 'Fibonacci', 'Fib speed resistance arcs', 2, FIBG, 'M2 16a14 14 0 0114-14M6 16a10 10 0 0110-10M10 16a6 6 0 016-6', { levels: true }),
    fibwedge: t('fib', 'Fibonacci', 'Fib wedge', 3, FIBG, 'M2 16L16 3M2 16h14M8 16a6 6 0 00-1.3-3.8M12 16a10 10 0 00-2.2-6.3', { levels: true }),
    pitchfan: t('fib', 'Fibonacci', 'Pitchfan', 3, '#f23645', 'M2 16L10 2M2 16L16 4M2 16L16 16M10 2l6 2v12'),
    fibext2: t('fib', 'Fibonacci', 'Fib extension (2-point)', 2, FIBG, 'M2 15L14 5M2 3h14M2 7h14M2 11h10', { ext: true, levels: true }),
    gannbox: t('fib', 'Gann', 'Gann box', 2, ORNG, 'M2 2h14v14H2zM2 9h14M9 2v14M2 16L16 2'),
    gannsqfixed: t('fib', 'Gann', 'Gann square fixed', 2, ORNG, 'M2 2h14v14H2zM2 16L16 2M2 16L16 9M2 16L9 2'),
    gannsquare: t('fib', 'Gann', 'Gann square', 2, ORNG, 'M2 2h14v14H2zM2 16L16 2M2 16A14 14 0 0116 2'),
    gannfan: t('fib', 'Gann', 'Gann fan', 2, ORNG, 'M2 16L16 2M2 16L16 9M2 16L9 2M2 16L16 13M2 16L5 2'),

    xabcd: t('patterns', 'Chart patterns', 'XABCD pattern', 5, BLUE, 'M1 14l4-10 4 6 4-5 4 9', { fill: true }),
    cypher: t('patterns', 'Chart patterns', 'Cypher pattern', 5, BLUE, 'M1 12l4-9 3 6 5-5 4 12', { fill: true }),
    hs: t('patterns', 'Chart patterns', 'Head and shoulders', 7, TEAL, 'M1 14l3-5 2 3 3-9 3 9 2-3 3 5M3 12h12', { fill: true }),
    abcd: t('patterns', 'Chart patterns', 'ABCD pattern', 4, TEAL, 'M2 14l5-10 4 6 5-8'),
    trianglepat: t('patterns', 'Chart patterns', 'Triangle pattern', 4, PURP, 'M2 3l4 12 4-9 4 6M2 3l14 7M6 15l10-5', { fill: true }),
    threedrives: t('patterns', 'Chart patterns', 'Three drives pattern', 7, PURP, 'M1 15l3-5 2 2 4-6 2 2 4-6'),
    ewimpulse: t('patterns', 'Elliott waves', 'Elliott impulse wave (1·2·3·4·5)', 6, '#3179f5', 'M1 15l3-6 3 3 4-8 3 3 3-5'),
    ewcorrection: t('patterns', 'Elliott waves', 'Elliott correction wave (A·B·C)', 4, '#3179f5', 'M2 4l5 8 4-4 5 8'),
    ewtriangle: t('patterns', 'Elliott waves', 'Elliott triangle wave (A·B·C·D·E)', 6, '#ff9800', 'M1 3l3 12 3-9 3 7 3-5 3 3'),
    ewdouble: t('patterns', 'Elliott waves', 'Elliott double combo wave (W·X·Y)', 4, '#4caf50', 'M2 4l5 6 3-3 6 8'),
    ewtriple: t('patterns', 'Elliott waves', 'Elliott triple combo wave (W·X·Y·X·Z)', 6, '#4caf50', 'M1 3l4 6 2-2 4 5 2-2 4 5'),
    cycliclines: t('patterns', 'Cycles', 'Cyclic lines', 2, BLUE, 'M3 2v14M8 2v14M13 2v14'),
    timecycles: t('patterns', 'Cycles', 'Time cycles', 2, BLUE, 'M1 14a4 4 0 018 0 4 4 0 018 0M1 14h16'),
    sineline: t('patterns', 'Cycles', 'Sine line', 2, BLUE, 'M1 9c3-8 5-8 8 0s5 8 8 0'),

    long: t('forecast', 'Forecasting', 'Long position', 1, TEAL, 'M2 10h14M9 15V4M6 7l3-3 3 3', { line: false }),
    short: t('forecast', 'Forecasting', 'Short position', 1, RED, 'M2 8h14M9 3v11M6 11l3 3 3-3', { line: false }),
    forecast: t('forecast', 'Forecasting', 'Position forecast', 2, BLUE, 'M2 13l6-4 8-5M12 4h4v4M2 13h14'),
    barspattern: t('forecast', 'Forecasting', 'Bars pattern', 2, BLUE, 'M4 3v12M3 6h2v6H3zM9 2v12M8 4h2v5H8zM14 5v11M13 8h2v5h-2z', { bars: true, line: false }),
    ghostfeed: t('forecast', 'Forecasting', 'Ghost feed', 'multi', '#9598a1', 'M2 12l5-3 4 2 5-6M5 7v6M10 6v9M14 3v7', { bars: true, line: false }),
    sector: t('forecast', 'Forecasting', 'Sector', 3, BLUE, 'M3 15h12A12 12 0 006 4z', { fill: true }),
    projection: t('forecast', 'Forecasting', 'Projection', 3, BLUE, 'M2 15L15 4M2 15L16 13M15 4a12 12 0 011 9', { fill: true }),
    avwap: t('forecast', 'Volume-based', 'Anchored VWAP', 1, '#f7b924', 'M3 3v13M3 13c4-2 6-6 13-8M1 3h4', { bars: true }),
    fixedvp: t('forecast', 'Volume-based', 'Fixed range volume profile', 2, BLUE, 'M2 3h8M2 6h12M2 9h14M2 12h9M2 15h5', { bars: true, line: false }),
    anchoredvp: t('forecast', 'Volume-based', 'Anchored volume profile', 1, BLUE, 'M3 2v14M3 4h7M3 7h11M3 10h8M3 13h4', { bars: true, line: false }),
    pricerange: t('forecast', 'Measurers', 'Price range', 2, BLUE, 'M9 3v12M6 6l3-3 3 3M6 12l3 3 3-3M2 2h14M2 16h14', { line: false }),
    daterange: t('forecast', 'Measurers', 'Date range', 2, BLUE, 'M3 9h12M6 6L3 9l3 3M12 6l3 3-3 3M2 2v14M16 2v14', { line: false }),
    measure: t('forecast', 'Measurers', 'Date & price range', 2, BLUE, 'M2 12L12 2l4 4L6 16zM5 9l1.5 1.5M8 6l1.5 1.5M11 3l1.5 1.5', { line: false }),
    ruler: t('forecast', 'Measurers', 'Ruler', 2, GREY, 'M1 13L13 1l4 4L5 17zM4 10l1.5 1.5M7 7l2 2M10 4l1.5 1.5'),

    brush: t('shapes', 'Brushes', 'Brush', 0, ORNG, 'M3 14c2-6 4 2 6-3s3-6 6-7', { width: 2 }),
    highlighter: t('shapes', 'Brushes', 'Highlighter', 0, '#f7b924', 'M3 15l3-3 8-8 2 2-8 8-3 3zM2 16h6', { width: 14 }),
    arrowmarker: t('shapes', 'Arrows', 'Arrow marker', 2, BLUE, 'M2 14l8-8-2-2h7v7l-2-2-8 8z', { line: false, text: true }),
    arrow: t('shapes', 'Arrows', 'Arrow', 2, BLUE, 'M3 15L15 3M9 3h6v6', { type: 'trend', props: { arrow: true }, ext: true, stats: true }),
    arrowup: t('shapes', 'Arrows', 'Arrow mark up', 1, TEAL, 'M9 2l5 6h-3v8H7V8H4z', { line: false, text: true }),
    arrowdown: t('shapes', 'Arrows', 'Arrow mark down', 1, RED, 'M9 16l5-6h-3V2H7v8H4z', { line: false, text: true }),
    arrowleft: t('shapes', 'Arrows', 'Arrow mark left', 1, BLUE, 'M2 9l6-5v3h8v4H8v3z', { line: false, text: true }),
    arrowright: t('shapes', 'Arrows', 'Arrow mark right', 1, BLUE, 'M16 9l-6-5v3H2v4h8v3z', { line: false, text: true }),
    doublearrow: t('shapes', 'Arrows', 'Double arrow', 2, BLUE, 'M3 15L15 3M3 9v6h6M9 3h6v6', { type: 'trend', props: { arrow: true, arrow2: true }, ext: true, stats: true }),
    rect: t('shapes', 'Shapes', 'Rectangle', 2, PURP, 'M3 4h12v10H3z', { fill: true }),
    rotrect: t('shapes', 'Shapes', 'Rotated rectangle', 3, PURP, 'M2 9l7-7 7 7-7 7z', { fill: true }),
    path: t('shapes', 'Shapes', 'Path', 'multi', BLUE, 'M2 15l4-8 5 4 5-9M13 2h3v3'),
    circle: t('shapes', 'Shapes', 'Circle', 2, PURP, 'M9 2a7 7 0 110 14A7 7 0 119 2z', { fill: true }),
    ellipse: t('shapes', 'Shapes', 'Ellipse', 2, PURP, 'M9 4c4.5 0 8 2.2 8 5s-3.5 5-8 5-8-2.2-8-5 3.5-5 8-5z', { fill: true }),
    polyline: t('shapes', 'Shapes', 'Polyline', 'multi', BLUE, 'M2 14l3-9 6 3 5-5v12z', { fill: true, props: { fill: false } }),
    triangle: t('shapes', 'Shapes', 'Triangle', 3, PURP, 'M9 3l7 12H2z', { fill: true }),
    arc: t('shapes', 'Shapes', 'Arc', 3, PURP, 'M2 14a8 8 0 0114 0', { fill: true }),
    curve: t('shapes', 'Shapes', 'Curve', 3, BLUE, 'M2 15Q5 1 16 13'),
    doublecurve: t('shapes', 'Shapes', 'Double curve', 3, BLUE, 'M2 15C6 1 12 17 16 3'),
    roundrect: t('shapes', 'Shapes', 'Rounded rectangle', 2, PURP, 'M5 3h8a3 3 0 013 3v6a3 3 0 01-3 3H5a3 3 0 01-3-3V6a3 3 0 013-3z', { fill: true }),
    diamond: t('shapes', 'Shapes', 'Diamond', 2, PURP, 'M9 2l7 7-7 7-7-7z', { fill: true }),
    star: t('shapes', 'Shapes', 'Star', 2, '#f7b924', 'M9 2l2.1 4.5 4.9.6-3.6 3.3 1 4.8L9 12.8 4.6 15.2l1-4.8L2 7.1l4.9-.6z', { fill: true }),
    xmark: t('shapes', 'Shapes', 'Cross mark', 2, RED, 'M3 3l12 12M15 3L3 15'),
    frame: t('shapes', 'Shapes', 'Frame', 2, GREY, 'M2 5h14v11H2zM2 2h7v3', { fill: true, text: true, props: { text: 'Frame', fill: false } }),
    hzone: t('shapes', 'Zones', 'Price zone', 2, TEAL, 'M1 5h16M1 13h16M4 8h10M4 10h10', { fill: true }),
    vzone: t('shapes', 'Zones', 'Date zone', 2, BLUE, 'M5 1v16M13 1v16M8 4v10M10 4v10', { fill: true }),

    text: t('annotation', 'Text and notes', 'Text', 1, GREY, 'M4 4h10M9 4v11', { text: true, edit: true, size: true, line: false }),
    anchoredtext: t('annotation', 'Text and notes', 'Anchored text', 1, GREY, 'M4 4h10M9 4v8M2 15h4M2 13v4', { text: true, edit: true, size: true, line: false }),
    note: t('annotation', 'Text and notes', 'Note', 1, '#f7b924', 'M3 3h12v9l-4 4H3zM11 16v-4h4', { text: true, edit: true, line: false, props: { text: 'Note' } }),
    pricenote: t('annotation', 'Text and notes', 'Price note', 2, BLUE, 'M3 14l6-6M9 4h7v5H9z', { text: true }),
    pin: t('annotation', 'Text and notes', 'Pin', 1, '#f23645', 'M9 16v-5M9 2a4.5 4.5 0 010 9 4.5 4.5 0 010-9z', { text: true, edit: true, line: false }),
    table: t('annotation', 'Text and notes', 'Table', 1, BLUE, 'M2 3h14v12H2zM2 7h14M2 11h14M9 3v12', { text: true, edit: true, line: false, props: { text: 'Name | Value\nEntry | \nTarget | ' } }),
    callout: t('annotation', 'Text and notes', 'Callout', 2, BLUE, 'M2 3h14v8H8l-4 4v-4H2z', { text: true, edit: true, line: false, props: { text: 'Callout' } }),
    pricelabel: t('annotation', 'Text and notes', 'Price label', 1, BLUE, 'M2 9l4-5h10v10H6z', { line: false }),
    signpost: t('annotation', 'Text and notes', 'Signpost', 1, BLUE, 'M9 16V2M4 3h9l3 3-3 3H4z', { text: true, edit: true, line: false, props: { text: 'Signpost' } }),
    flag: t('annotation', 'Text and notes', 'Flag mark', 1, '#f23645', 'M4 16V2M4 3h10l-3 3 3 3H4', { line: false }),
    pricetime: t('annotation', 'Text and notes', 'Price-time label', 1, BLUE, 'M2 9l4-5h10v10H6zM9 7h5M9 11h4', { line: false }),
    anchorednote: t('annotation', 'Text and notes', 'Anchored note', 1, '#f7b924', 'M4 4h11v8l-3 3H4zM12 15v-3h3M1 1h3v3', { text: true, edit: true, line: false, props: { text: 'Note' } }),
    comment: t('annotation', 'Text and notes', 'Comment', 1, BLUE, 'M3 3h12a1 1 0 011 1v7a1 1 0 01-1 1H8l-4 4v-4H3a1 1 0 01-1-1V4a1 1 0 011-1z', { text: true, edit: true, line: false, props: { text: 'Comment' } }),
    ...Object.fromEntries([
      ['smile', 'Smile', '😀', 'M9 2a7 7 0 110 14A7 7 0 119 2zM6.5 7v.5M11.5 7v.5M5.5 10.5a4 4 0 007 0'],
      ['rocket', 'Rocket', '🚀', 'M9 1c3 2 4 6 3 10H6C5 7 6 3 9 1zM6 11l-2 4 3-1M12 11l2 4-3-1'],
      ['fire', 'Fire', '🔥', 'M9 16a5 5 0 01-5-5c0-3 3-5 3-9 2 2 3 3 3 5 1-1 1-2 1-3 2 2 3 4 3 7a5 5 0 01-5 5z'],
      ['money', 'Money', '💰', 'M2 5h14v8H2zM9 7a2 2 0 100 4 2 2 0 000-4z'],
      ['warning', 'Warning', '⚠️', 'M9 2l8 14H1zM9 7v4M9 13v.5'],
      ['check', 'Check mark', '✅', 'M3 9l4 4 8-9'],
      ['cancel', 'Cancel', '❌', 'M4 4l10 10M14 4L4 14'],
      ['bull', 'Chart up', '📈', 'M2 14l5-5 3 3 6-7M12 5h4v4'],
      ['bear', 'Chart down', '📉', 'M2 4l5 5 3-3 6 7M12 13h4V9'],
      ['target', 'Target', '🎯', 'M9 1v16M1 9h16M9 4a5 5 0 110 10A5 5 0 119 4z'],
      ['clock', 'Clock', '⏰', 'M9 2a7 7 0 110 14A7 7 0 119 2zM9 5v4l3 2'],
      ['idea', 'Idea', '💡', 'M6 13h6M7 16h4M9 1a5 5 0 00-3 9v3h6v-3a5 5 0 00-3-9z'],
    ].map(([k, label, glyph, icon]) => ['icon_' + k, t('annotation', 'Icons', label, 1, GREY, icon, { type: 'icon', glyph: true, line: false, props: { glyph, size: 28 } })])),
  };
  const DASH = [[], [6, 4], [2, 3]];
  const TAU = Math.PI * 2;
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const hyp = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const lerp = (a, b, k) => ({ x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k });
  const normA = (a) => ((a % TAU) + TAU) % TAU;
  function distSeg(p, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy;
    const k = L2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2)) : 0;
    return Math.hypot(p.x - a.x - k * dx, p.y - a.y - k * dy);
  }
  function inPoly(p, pts) {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const a = pts[i], b = pts[j];
      if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
    }
    return inside;
  }
  const angleIn = (a, a0, a1, ccw) => {
    if (Math.abs(a1 - a0) >= TAU - 1e-9) return true;
    return ccw ? normA(a0 - a) <= normA(a0 - a1) : normA(a - a0) <= normA(a1 - a0);
  };
  const alpha = (hex, a) => {
    if (!/^#[0-9a-f]{6}$/i.test(hex)) return hex;
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
  };
  function circumcircle(a, b, c) {
    const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
    if (Math.abs(d) < 1e-6) return null;
    const a2 = a.x * a.x + a.y * a.y, b2 = b.x * b.x + b.y * b.y, c2 = c.x * c.x + c.y * c.y;
    const x = (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d, y = (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d;
    return { x, y, r: Math.hypot(a.x - x, a.y - y) };
  }
  const bezier = (p0, c1, c2, p1, n = 40) => {
    const out = [];
    for (let i = 0; i <= n; i++) {
      const k = i / n, u = 1 - k;
      out.push(c2
        ? { x: u * u * u * p0.x + 3 * u * u * k * c1.x + 3 * u * k * k * c2.x + k * k * k * p1.x, y: u * u * u * p0.y + 3 * u * u * k * c1.y + 3 * u * k * k * c2.y + k * k * k * p1.y }
        : { x: u * u * p0.x + 2 * u * k * c1.x + k * k * p1.x, y: u * u * p0.y + 2 * u * k * c1.y + k * k * p1.y });
    }
    return out;
  };
  const seeded = (s) => { let a = 0; for (let i = 0; i < s.length; i++) a = (a * 31 + s.charCodeAt(i)) | 0; return () => { a = (a + 0x6d2b79f5) | 0; let x = Math.imul(a ^ (a >>> 15), 1 | a); x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x; return ((x ^ (x >>> 14)) >>> 0) / 4294967296; }; };
  const pctTxt = (dp, base) => (base ? ((dp / base) * 100).toFixed(2) : '0.00');
  const sgn = (v) => (v >= 0 ? '+' : '');
  const ANCH = { anchoredtext: true, anchorednote: true };
  const STYLE_KEYS = ['color', 'width', 'style', 'fill', 'extL', 'extR', 'showStats', 'more', 'levels', 'size', 'bg', 'dev', 'rows'];
  const VIS_UNITS = [
    { k: 'seconds', label: 'Seconds', u: 'S', r: [1, 59] }, { k: 'minutes', label: 'Minutes', u: 'm', r: [1, 59] }, { k: 'hours', label: 'Hours', u: 'H', r: [1, 24] },
    { k: 'days', label: 'Days', u: 'D', r: [1, 366] }, { k: 'weeks', label: 'Weeks', u: 'W', r: [1, 52] }, { k: 'months', label: 'Months', u: 'M', r: [1, 12] },
    { k: 'ticks', label: 'Ticks' }, { k: 'ranges', label: 'Ranges' },
  ];
  const UNIT_KEY = Object.fromEntries(VIS_UNITS.filter((x) => x.u).map((x) => [x.u, x.k]));
  const parseIv = (iv) => {
    if (!iv) return null;
    if (typeof iv === 'object') return iv.kind ? iv : null;
    if (window.IGTypes && window.IGTypes.parseInterval) return window.IGTypes.parseInterval(iv);
    return null;
  };
  // d.visibility: { seconds|minutes|hours|days|weeks|months: [min,max] | false, ticks|ranges: bool }; missing key = visible
  function visibleOn(vis, iv) {
    iv = parseIv(iv);
    if (!vis || !iv) return true;
    if (iv.kind === 'ticks') return vis.ticks !== false;
    if (iv.kind === 'range') return vis.ranges !== false;
    const v = vis[UNIT_KEY[iv.unit]];
    if (v === false) return false;
    if (Array.isArray(v)) return iv.n >= v[0] && iv.n <= v[1];
    return true;
  }

  // ── alert geometry (contract G) — pure, no DOM ──
  const fin = (...v) => v.every(Number.isFinite);
  function gLine(a, b, extL, extR) {
    if (!a || !b || !fin(a.t, a.p, b.t, b.p) || a.t === b.t) return null;
    if (a.t > b.t) [a, b, extL, extR] = [b, a, extR, extL];
    return { t1: a.t, p1: a.p, t2: b.t, p2: b.p, extL: !!extL, extR: !!extR };
  }
  function gBand(l1, l2) {
    if (!l1 || !l2) return null;
    const tm = (Math.max(l1.t1, l2.t1) + Math.min(l1.t2, l2.t2)) / 2, a = lineAt(l1, tm, true), b = lineAt(l2, tm, true);
    return a >= b ? { kind: 'band', upper: l1, lower: l2 } : { kind: 'band', upper: l2, lower: l1 };
  }
  function gBox(ts, ps) {
    if (!fin(...ts, ...ps)) return null;
    const t1 = Math.min(...ts), t2 = Math.max(...ts), p1 = Math.min(...ps), p2 = Math.max(...ps);
    return t2 > t1 && p2 > p1 ? { kind: 'box', t1, t2, p1, p2 } : null;
  }
  function lineAt(l, t, free) {
    if (!l || !fin(l.t1, l.p1, l.t2, l.p2, t) || l.t1 === l.t2) return null;
    const lo = Math.min(l.t1, l.t2), hi = Math.max(l.t1, l.t2), loExt = l.t1 <= l.t2 ? l.extL : l.extR, hiExt = l.t1 <= l.t2 ? l.extR : l.extL;
    if (!free && ((t < lo && !loExt) || (t > hi && !hiExt))) return null;
    return l.p1 + ((l.p2 - l.p1) * (t - l.t1)) / (l.t2 - l.t1);
  }
  function alertGeometry(d) {
    if (!d || !Array.isArray(d.pts) || !d.pts.length || !d.pts.every((q) => q && fin(q.t, q.p))) return null;
    const P = d.pts, [A, B, C] = P;
    switch (d.type) {
      case 'hline': case 'cross': return { kind: 'hline', p: A.p };
      case 'hray': return { kind: 'line', t1: A.t, p1: A.p, t2: A.t + 1, p2: A.p, extL: false, extR: true };
      case 'trend': case 'angle': { const l = gLine(A, B, d.extL, d.extR); return l && { kind: 'line', ...l }; }
      case 'channel': {
        if (!C) return null;
        const top = gLine(A, B, d.extL, d.extR); if (!top) return null;
        const off = C.p - lineAt(top, C.t, true);
        return gBand(top, gLine({ t: A.t, p: A.p + off }, { t: B.t, p: B.p + off }, d.extL, d.extR));
      }
      case 'flatchannel': return C ? gBand(gLine(A, B), gLine({ t: A.t, p: C.p }, { t: B.t, p: C.p })) : null;
      case 'disjoint': return C ? gBand(gLine(A, B), gLine({ t: A.t, p: C.p }, { t: B.t, p: C.p - (B.p - A.p) })) : null;
      case 'hzone': {
        const t1 = Math.min(A.t, B.t), t2 = Math.max(A.t, B.t) + (A.t === B.t ? 1 : 0), hi = Math.max(A.p, B.p), lo = Math.min(A.p, B.p);
        return hi > lo ? { kind: 'band', upper: { t1, p1: hi, t2, p2: hi, extL: true, extR: true }, lower: { t1, p1: lo, t2, p2: lo, extL: true, extR: true } } : null;
      }
      case 'rect': case 'roundrect': case 'frame': case 'pricerange': case 'measure': return B ? gBox([A.t, B.t], [A.p, B.p]) : null;
      case 'rotrect': {
        if (!C) return null;
        const ts = [A.t, B.t, C.t], ps = [A.p, B.p, C.p], st = Math.max(...ts) - Math.min(...ts) || 1, sp = Math.max(...ps) - Math.min(...ps) || 1;
        const ax = A.t / st, ay = A.p / sp, bx = B.t / st, by = B.p / sp, len = Math.hypot(bx - ax, by - ay) || 1, nx = -(by - ay) / len, ny = (bx - ax) / len;
        const off = (C.t / st - ax) * nx + (C.p / sp - ay) * ny;
        return gBox([A.t, B.t, A.t + nx * off * st, B.t + nx * off * st], [A.p, B.p, A.p + ny * off * sp, B.p + ny * off * sp]);
      }
      default: return null;
    }
  }
  // hline/line → price | null; band/box → { upper, lower } (either side may be null for a band) | null
  function priceAt(g, t) {
    if (!g || !Number.isFinite(t)) return null;
    if (g.kind === 'hline') return Number.isFinite(g.p) ? g.p : null;
    if (g.kind === 'line') return lineAt(g, t);
    if (g.kind === 'band') { const upper = lineAt(g.upper, t), lower = lineAt(g.lower, t); return upper == null && lower == null ? null : { upper, lower }; }
    if (g.kind === 'box') return t >= g.t1 && t <= g.t2 ? { upper: Math.max(g.p1, g.p2), lower: Math.min(g.p1, g.p2) } : null;
    return null;
  }
  let MEM_TPL = {}, CLIP = null;

  function profile(cs, nRows) {
    let hi = -Infinity, lo = Infinity;
    for (const c of cs) { if (c.high > hi) hi = c.high; if (c.low < lo) lo = c.low; }
    if (!(hi > lo)) { hi = lo + Math.abs(lo || 1) * 1e-4; }
    const step = (hi - lo) / nRows, rows = Array.from({ length: nRows }, (_, i) => ({ p0: lo + i * step, p1: lo + (i + 1) * step, up: 0, down: 0 }));
    let total = 0;
    for (const c of cs) {
      const v = c.volume > 0 ? c.volume : 1, up = c.close >= c.open, span = c.high - c.low;
      total += v;
      const i0 = Math.max(0, Math.min(nRows - 1, Math.floor((c.low - lo) / step))), i1 = Math.max(0, Math.min(nRows - 1, Math.floor((c.high - lo) / step)));
      for (let i = i0; i <= i1; i++) {
        const r = rows[i], part = span > 0 ? v * (Math.min(c.high, r.p1) - Math.max(c.low, r.p0)) / span : v / (i1 - i0 + 1);
        if (part > 0) { if (up) r.up += part; else r.down += part; }
      }
    }
    let poc = 0, max = 0;
    rows.forEach((r, i) => { const v = r.up + r.down; if (v > max) { max = v; poc = i; } });
    let a = poc, b = poc, acc = rows[poc].up + rows[poc].down;
    const vol = (i) => (i >= 0 && i < nRows ? rows[i].up + rows[i].down : -1);
    while (acc < total * 0.7 && (a > 0 || b < nRows - 1)) {
      const va = vol(a - 1), vb = vol(b + 1);
      if (vb >= va) { b++; acc += vb; } else { a--; acc += va; }
    }
    return { rows, max, poc: (rows[poc].p0 + rows[poc].p1) / 2, vah: rows[b].p1, val: rows[a].p0, hi, lo, total };
  }

  function create(host) {
    const { el, canvas, toolbar, hint } = host;
    const ctx = canvas.getContext('2d');
    const S = {
      all: host.load() || {}, tool: null, draft: null, sel: null, drag: null, hover: null, lastSel: null,
      magnet: false, lockAll: false, hidden: false, blank: true, down: null, editing: null, stay: false, gc: new Map(),
      set: new Set(), pop: null, iv: null, pasteN: 0,
    };
    // undo history lives on the (possibly shared) store so every engine showing a market shares it; non-enumerable keeps it out of saves
    let H = S.all.__hist;
    if (!H) { H = { undo: {}, redo: {} }; try { Object.defineProperty(S.all, '__hist', { value: H, enumerable: false, configurable: true }); } catch (e) { /* frozen store */ } }
    const key = () => host.key();
    const cur = () => { const k = key(); if (!k) return []; return (S.all[k] = S.all[k] || []); };
    const save = () => { for (const k of Object.keys(S.all)) if (Array.isArray(S.all[k]) && !S.all[k].length) delete S.all[k]; host.save(S.all); host.onChange && host.onChange(); };
    const pushHist = (json) => {
      const k = key(); if (!k) return;
      (H.undo[k] = H.undo[k] || []).push(json || JSON.stringify(cur()));
      if (H.undo[k].length > 100) H.undo[k].shift();
      H.redo[k] = [];
    };
    const snapshot = () => pushHist();
    const toolOf = (d) => TOOLS[d.tool] || TOOLS[d.type] || {};
    const setSel = (d) => { S.sel = d || null; S.set = new Set(S.sel ? [S.sel] : []); S.pop = null; notifySel(); };
    const setMany = (ds) => { S.set = new Set(ds); S.sel = ds.includes(S.sel) ? S.sel : ds[ds.length - 1] || null; S.pop = null; notifySel(); };
    const toggleSel = (d) => { const ds = [...S.set]; if (S.set.has(d)) { setMany(ds.filter((x) => x !== d)); return false; } setMany(ds.concat(d)); S.sel = d; notifySel(); return true; };
    const isSel = (d) => S.set.has(d);
    const selList = () => [...S.set];
    const selSig = () => (S.sel ? S.sel.id : '') + '|' + selList().map((d) => d.id).join(',');
    const notifySel = () => { const s = selSig(); if (s !== S.lastSel) { S.lastSel = s; host.onSelect && host.onSelect(S.sel ? info(S.sel) : null); } };
    const info = (d) => ({
      id: d.id, type: d.tool || d.type, label: toolOf(d).label || d.type, name: d.name || toolOf(d).label || d.type, color: d.color, hidden: !!d.hidden, locked: !!d.locked,
      selected: isSel(d), text: d.text, group: d.group || null, groupHidden: !!d.gHidden, groupLocked: !!d.gLocked, visibility: d.visibility || null, visibleNow: visibleOn(d.visibility, S.iv),
    });
    const ivNow = () => { try { S.iv = host.interval ? parseIv(host.interval()) : null; } catch (e) { S.iv = null; } return S.iv; };
    const shown = (d) => !d.hidden && !d.gHidden && visibleOn(d.visibility, S.iv);
    const lk = (d) => !!(S.lockAll || d.locked || d.gLocked);
    const byId = (id) => (id && typeof id === 'object' ? id : cur().find((d) => d.id === id));

    // ── bar data (optional host.candles) with a short-lived per-drawing cache ──
    const cache = new WeakMap();
    const bars = (t1, t2) => (host.candles ? host.candles(Math.min(t1, t2), Math.max(t1, t2)) || [] : null);
    function cached(d, k, fn) {
      const e = cache.get(d), now = performance.now();
      if (e && e.k === k && now - e.at < 500) return e.v;
      const v = fn(); cache.set(d, { k, at: now, v }); return v;
    }
    const FAR = 4e9;

    // ── geometry: tools emit primitives ──────────────
    const xy = (pt) => host.toXY(pt.t, pt.p);
    const extend = (a, b, back, fwd) => {
      const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1, K = 8000;
      return { a: back ? { x: a.x - (dx / len) * K, y: a.y - (dy / len) * K } : a, b: fwd ? { x: b.x + (dx / len) * K, y: b.y + (dy / len) * K } : b };
    };
    const ray = (o, through) => extend(o, through, false, true).b;
    let G = null, D = null;
    const Y = (p) => { const q = host.toXY(D.pts[0].t, p); return q ? q.y : NaN; };
    const X = (tm) => { const q = host.toXY(tm, D.pts[0].p); return q ? q.x : NaN; };
    const fillA = (a) => (D.fill === false ? null : alpha(D.color, a));
    const L = (a, b, o) => G.prims.push(Object.assign({ k: 'L', a, b }, o));
    const PL = (pts, o) => G.prims.push(Object.assign({ k: 'PL', pts }, o));
    const E = (x, y, rx, ry, o) => G.prims.push(Object.assign({ k: 'E', x, y, rx: Math.max(0.5, rx), ry: Math.max(0.5, ry) }, o));
    const R = (x, y, w, h, o) => G.prims.push(Object.assign({ k: 'R', x: Math.min(x, x + w), y: Math.min(y, y + h), rw: Math.abs(w), rh: Math.abs(h) }, o));
    const MEAS = new Map();
    const textW = (s, font) => {
      const k = font + '|' + s; let v = MEAS.get(k);
      if (v == null) { if (MEAS.size > 3000) MEAS.clear(); ctx.font = font; v = ctx.measureText(s).width; MEAS.set(k, v); }
      return v;
    };
    function TX(text, x, y, o = {}) {
      const size = o.size || 11.5, pad = o.pad ?? (o.bg ? 5 : 2), lh = Math.round(size * 1.3);
      const lines = String(text).split('\n'), font = `${o.bold ? '600 ' : ''}${size}px ${FONT}`;
      const tw = Math.max(o.minW || 0, ...lines.map((l) => textW(l, font)));
      const bw = tw + pad * 2, bh = lines.length * lh + pad, align = o.align || 'center', base = o.base || 'middle';
      const bx = align === 'center' ? x - bw / 2 : align === 'right' ? x - bw : x;
      const by = base === 'middle' ? y - bh / 2 : base === 'bottom' ? y - bh : y;
      const pr = { k: 'T', lines, font, size, lh, pad, bx, by, bw, bh, bg: o.bg, fg: o.fg || '#fff', border: o.border, nohit: o.nohit };
      if (o.avoid) {
        if (G.avoid.some((b) => bx < b.bx + b.bw && b.bx < bx + bw && by < b.by + b.bh && b.by < by + bh)) return pr;
        G.avoid.push(pr);
      }
      G.prims.push(pr); return pr;
    }
    const arrowHead = (a, b, s = 10, o) => {
      const ang = Math.atan2(b.y - a.y, b.x - a.x);
      PL([{ x: b.x - s * Math.cos(ang - 0.45), y: b.y - s * Math.sin(ang - 0.45) }, b, { x: b.x - s * Math.cos(ang + 0.45), y: b.y - s * Math.sin(ang + 0.45) }], Object.assign({ dash: 0, nohit: true }, o));
    };
    const dot = (q, r = 3, c) => E(q.x, q.y, r, r, { fill: c || D.color, stroke: false, nohit: true });
    const isHigh = (P, i) => {
      const a = P[i - 1], b = P[i + 1];
      if (a && b) return P[i].y <= Math.min(a.y, b.y) || (P[i].y < Math.max(a.y, b.y) && P[i].y < (a.y + b.y) / 2);
      return (a || b) ? P[i].y < (a || b).y : true;
    };
    const vlabel = (P, i, text, o = {}) => {
      const up = isHigh(P, i);
      TX(text, P[i].x, P[i].y + (up ? -7 : 7), Object.assign({ base: up ? 'bottom' : 'top', bg: o.plain ? null : D.color, fg: o.plain ? D.color : '#fff', bold: true, nohit: true, size: o.size }));
    };
    const ratio = (i, j, k, l) => { const p = D.pts; const den = Math.abs(p[l].p - p[k].p); return den ? (Math.abs(p[j].p - p[i].p) / den).toFixed(3) : '—'; };
    const textAt = (pr, size) => { G.box = pr; G.textAt = { x: pr.bx + pr.pad, y: pr.by, size }; };
    const active = (d) => isSel(d) || d === S.hover || d === S.draft;
    const noData = (P, msg) => {
      const a = P[0], b = P[1] || { x: P[0].x + 60, y: P[0].y + 30 };
      R(a.x, a.y, b.x - a.x, b.y - a.y || 30, { dash: 1, w: 1, fill: alpha(D.color, 0.05) });
      if (msg) TX(msg, (a.x + b.x) / 2, (a.y + b.y) / 2, { fg: D.color, nohit: true });
    };
    // horizontal fib-style levels between xs..xe; labels to the left of xs
    function hLevels(levels, priceOf, xs, xe, fill) {
      const Ls = levels.map((lv, i) => ({ lv, c: Array.isArray(lv) ? lv[1] : fibColor(lv, i), v: Array.isArray(lv) ? lv[0] : lv })).map((o) => ({ ...o, p: priceOf(o.v) })).map((o) => ({ ...o, y: Y(o.p) })).filter((o) => Number.isFinite(o.y));
      if (fill) for (let i = 1; i < Ls.length; i++) R(xs, Ls[i - 1].y, xe - xs, Ls[i].y - Ls[i - 1].y, { fill: alpha(Ls[i].c, 0.08), stroke: false, nohit: true });
      for (const o of Ls) {
        L({ x: xs, y: o.y }, { x: xe, y: o.y }, { c: o.c, w: 1, dash: 0 });
        TX(`${o.v} (${host.fmt(o.p)})`, Math.min(xs, xe) - 4, o.y, { align: 'right', fg: o.c, nohit: true, size: 11, avoid: true });
      }
    }

    const pitchfork = (d, g, P) => {
      const A = P[0], B = P[1], C = P[2] || P[1], M = mid(B, C);
      const O = d.variant === 'schiff' ? { x: A.x, y: (A.y + B.y) / 2 } : d.variant === 'modschiff' ? mid(A, B) : d.variant === 'inside' ? mid(A, M) : A;
      const vx = M.x - O.x, vy = M.y - O.y, len = Math.hypot(vx, vy) || 1, far = (q) => ({ x: q.x + (vx / len) * 6000, y: q.y + (vy / len) * 6000 });
      if (len > 1) {
        const f = fillA(0.06); if (f) PL([B, far(B), far(C), C], { close: true, fill: f, stroke: false, nohit: true });
        L(O, far(M)); L(B, far(B)); L(C, far(C));
        const lv = d.more ? [0.25, 0.5, 0.75, 1.5, 2] : [0.5];
        lv.forEach((k, i) => { for (const s of [B, C]) { const q = lerp(M, s, k); L(q, far(q), { w: 1, dash: 2, c: fibColor(k, i + 3) }); } });
      }
      L(B, C, { w: 1 });
      if (O !== A) L(A, O, { w: 1, dash: 1 });
    };
    const gannSquare = (fixed) => (d, g, P) => {
      let [A, B] = P;
      if (fixed) { const s = Math.max(Math.abs(B.x - A.x), Math.abs(B.y - A.y)); B = { x: A.x + Math.sign(B.x - A.x || 1) * s, y: A.y + Math.sign(B.y - A.y || 1) * s }; g.handles = [A, B]; }
      const dx = B.x - A.x, dy = B.y - A.y;
      R(A.x, A.y, dx, dy, { fill: alpha(d.color, 0.05), w: 1 });
      for (const k of [0.25, 0.5, 0.75]) { L({ x: A.x + dx * k, y: A.y }, { x: A.x + dx * k, y: B.y }, { w: 1, dash: 2, c: alpha(d.color, 0.6), nohit: true }); L({ x: A.x, y: A.y + dy * k }, { x: B.x, y: A.y + dy * k }, { w: 1, dash: 2, c: alpha(d.color, 0.6), nohit: true }); }
      [0.25, 0.5, 0.75, 1].forEach((k, i) => {
        L(A, { x: B.x, y: A.y + dy * k }, { w: 1, c: PAL[(i + 2) % PAL.length] });
        if (k < 1) L(A, { x: A.x + dx * k, y: B.y }, { w: 1, c: PAL[(i + 2) % PAL.length] });
        const a0 = dx >= 0 ? 0 : Math.PI, a1 = dy >= 0 ? Math.PI / 2 : -Math.PI / 2;
        E(A.x, A.y, Math.abs(dx) * k, Math.abs(dy) * k, { a0, a1, ccw: normA(a1 - a0) > Math.PI, w: 1, c: alpha(d.color, 0.8), nohit: true });
      });
      L(A, B, { w: 1 }); L({ x: A.x, y: B.y }, { x: B.x, y: A.y }, { w: 1 });
    };
    const PATTERNS = {
      xabcd: { labels: ['X', 'A', 'B', 'C', 'D'], fills: [[0, 1, 2], [2, 3, 4]], rat: [[0, 2, [1, 2, 0, 1]], [1, 3, [2, 3, 1, 2]], [2, 4, [3, 4, 2, 3]], [0, 4, [1, 4, 0, 1]]] },
      cypher: { labels: ['X', 'A', 'B', 'C', 'D'], fills: [[0, 1, 2], [2, 3, 4]], rat: [[0, 2, [1, 2, 0, 1]], [0, 3, [1, 3, 0, 1]], [2, 4, [3, 4, 0, 3]]] },
      abcd: { labels: ['A', 'B', 'C', 'D'], fills: [], rat: [[0, 2, [1, 2, 0, 1]], [1, 3, [2, 3, 1, 2]]] },
      threedrives: { labels: ['', '1', 'A', '2', 'B', '3', ''], fills: [], rat: [[1, 3, [2, 3, 1, 2]], [3, 5, [4, 5, 3, 4]], [2, 4, [3, 4, 2, 3]]] },
      hs: { labels: ['', 'Left shoulder', '', 'Head', '', 'Right shoulder', ''], fills: [[0, 1, 2], [2, 3, 4], [4, 5, 6]], rat: [] },
      trianglepat: { labels: ['A', 'B', 'C', 'D'], fills: [], rat: [] },
    };
    const pattern = (d, g, P) => {
      const S0 = PATTERNS[d.type], f = fillA(0.14);
      if (f) for (const tri of S0.fills) if (tri.every((i) => P[i])) PL(tri.map((i) => P[i]), { close: true, fill: f, stroke: false, nohit: true });
      if (d.type === 'trianglepat' && P.length >= 4) {
        if (f) PL([P[0], P[2], P[3], P[1]], { close: true, fill: f, stroke: false, nohit: true });
        L(P[0], ray(P[0], P[2]), { w: 1, dash: 1 }); L(P[1], ray(P[1], P[3]), { w: 1, dash: 1 });
      }
      if (d.type === 'hs' && P.length >= 5) {
        const s = (P[4].y - P[2].y) / ((P[4].x - P[2].x) || 1), x0 = P[0].x, x1 = (P[6] || P[4]).x;
        L({ x: x0, y: P[2].y + (x0 - P[2].x) * s }, { x: x1, y: P[2].y + (x1 - P[2].x) * s }, { w: 1, dash: 1 });
      }
      PL(P);
      for (const [i, j, r] of S0.rat) if (P[j] && r.every((k) => P[k])) {
        L(P[i], P[j], { w: 1, dash: 1 });
        const m = mid(P[i], P[j]); TX(ratio(...r), m.x, m.y, { bg: alpha(d.color, 0.85), size: 11, nohit: true });
      }
      P.forEach((_, i) => S0.labels[i] && vlabel(P, i, S0.labels[i]));
    };
    const WAVES = {
      ewimpulse: ['(0)', '(1)', '(2)', '(3)', '(4)', '(5)'], ewcorrection: ['(0)', '(A)', '(B)', '(C)'], ewtriangle: ['(0)', '(A)', '(B)', '(C)', '(D)', '(E)'],
      ewdouble: ['(0)', '(W)', '(X)', '(Y)'], ewtriple: ['(0)', '(W)', '(X)', '(Y)', '(X)', '(Z)'],
    };
    const wave = (d, g, P) => { PL(P); P.forEach((_, i) => i && vlabel(P, i, WAVES[d.type][i], { plain: true, size: 12.5 })); };
    const profileTool = (fixed) => (d, g, P, w) => {
      const t0 = d.pts[0].t, t1 = fixed ? d.pts[1].t : FAR;
      const r = cached(d, `${t0}|${t1}|${d.rows || 24}`, () => { const cs = bars(t0, t1); return cs && cs.length ? { ...profile(cs, d.rows || 24), ta: cs[0].time, tb: cs[cs.length - 1].time } : cs ? false : null; });
      if (!r) return noData(P, r === null ? 'No bar data' : 'No bars in range');
      const xa = fixed ? Math.min(P[0].x, P[1].x) : P[0].x, xb = fixed ? Math.max(P[0].x, P[1].x) : Math.max(X(r.tb), xa + 1);
      const W = Math.max(30, (xb - xa) * 0.3), yHi = Y(r.hi), yLo = Y(r.lo);
      R(xa, yHi, xb - xa, yLo - yHi, { fill: alpha(d.color, 0.04), w: 1, dash: 2, c: alpha(d.color, 0.5) });
      for (const row of r.rows) {
        const ya = Y(row.p1), yb = Y(row.p0), hh = Math.max(1, Math.abs(yb - ya) - 1), inVA = row.p1 > r.val + 1e-12 && row.p0 < r.vah - 1e-12;
        const uw = (row.up / r.max) * W, dw = (row.down / r.max) * W;
        if (uw > 0) R(xa, Math.min(ya, yb), uw, hh, { fill: inVA ? 'rgba(41,98,255,.55)' : 'rgba(41,98,255,.22)', stroke: false, nohit: true });
        if (dw > 0) R(xa + uw, Math.min(ya, yb), dw, hh, { fill: inVA ? 'rgba(251,192,45,.55)' : 'rgba(251,192,45,.22)', stroke: false, nohit: true });
      }
      const yp = Y(r.poc);
      L({ x: xa, y: yp }, { x: xb, y: yp }, { c: '#ff5252', w: 1.5, dash: 0 });
      L({ x: xa, y: Y(r.vah) }, { x: xb, y: Y(r.vah) }, { c: BLUE, w: 1, dash: 1, nohit: true });
      L({ x: xa, y: Y(r.val) }, { x: xb, y: Y(r.val) }, { c: BLUE, w: 1, dash: 1, nohit: true });
      TX(`POC ${host.fmt(r.poc)}`, xb + 4, yp, { align: 'left', fg: '#ff5252', size: 11, nohit: true });
      g.handles = fixed ? [{ x: P[0].x, y: yp }, { x: P[1].x, y: yp }] : [{ x: P[0].x, y: yp }];
    };

    const BUILD = {
      trend(d, g, P) {
        const s = extend(P[0], P[1], d.extL, d.extR); L(s.a, s.b);
        if (d.arrow) arrowHead(P[0], P[1]);
        if (d.arrow2) arrowHead(P[1], P[0]);
        if ((d.showStats || d.info) && d.pts.length === 2) {
          const dp = d.pts[1].p - d.pts[0].p;
          let txt = `${sgn(dp)}${host.fmt(dp)} (${pctTxt(dp, d.pts[0].p)}%) · ${host.bars(d.pts[0].t, d.pts[1].t)} bars`;
          if (d.info) txt += `\n${host.dur(Math.abs(d.pts[1].t - d.pts[0].t))} · ${(-Math.atan2(P[1].y - P[0].y, P[1].x - P[0].x) * 180 / Math.PI).toFixed(1)}° · ${Math.round(hyp(P[0], P[1]))}px`;
          TX(txt, P[1].x, P[1].y - 14, { bg: alpha(d.color, 0.85), base: d.info ? 'bottom' : 'middle', nohit: true });
        }
      },
      angle(d, g, P) {
        const s = extend(P[0], P[1], d.extL, d.extR); L(s.a, s.b);
        const ang = Math.atan2(P[1].y - P[0].y, P[1].x - P[0].x), r = 34;
        L(P[0], { x: P[0].x + Math.max(r + 16, Math.abs(P[1].x - P[0].x)), y: P[0].y }, { w: 1, dash: 2, nohit: true });
        E(P[0].x, P[0].y, r, r, { a0: Math.min(0, ang), a1: Math.max(0, ang), w: 1, dash: 0, nohit: true });
        TX(`${(-ang * 180 / Math.PI).toFixed(2)}°`, P[0].x + r + 6, P[0].y + (ang < 0 ? -9 : 9), { align: 'left', fg: d.color, nohit: true, bold: true });
      },
      hline(d, g, P, w) { L({ x: 0, y: P[0].y }, { x: w, y: P[0].y }); g.handles = [{ x: Math.min(Math.max(P[0].x, 20), w - 20), y: P[0].y }]; },
      hray(d, g, P, w) { L(P[0], { x: Math.max(w, P[0].x), y: P[0].y }); },
      vline(d, g, P, w, h) { L({ x: P[0].x, y: 0 }, { x: P[0].x, y: h }); g.handles = [{ x: P[0].x, y: h / 2 }]; },
      cross(d, g, P, w, h) { L({ x: 0, y: P[0].y }, { x: w, y: P[0].y }); L({ x: P[0].x, y: 0 }, { x: P[0].x, y: h }); },
      channel(d, g, P) {
        const p2 = P[2] || P[1], dx = P[1].x - P[0].x, slope = dx ? (P[1].y - P[0].y) / dx : 0, off = p2.y - (P[0].y + slope * (p2.x - P[0].x));
        const top = extend(P[0], P[1], d.extL, d.extR), bot = extend({ x: P[0].x, y: P[0].y + off }, { x: P[1].x, y: P[1].y + off }, d.extL, d.extR);
        const mA = extend({ x: P[0].x, y: P[0].y + off / 2 }, { x: P[1].x, y: P[1].y + off / 2 }, d.extL, d.extR);
        const f = fillA(0.1); if (f) PL([top.a, top.b, bot.b, bot.a], { close: true, fill: f, stroke: false, nohit: true });
        L(top.a, top.b); L(bot.a, bot.b); L(mA.a, mA.b, { dash: [4, 4], w: 1, nohit: true });
        g.handles = [P[0], P[1], { x: (P[0].x + P[1].x) / 2, y: (P[0].y + P[1].y) / 2 + off }];
      },
      regression(d, g, P) {
        const [ia, ib] = d.pts[0].t <= d.pts[1].t ? [0, 1] : [1, 0];
        const r = cached(d, `${d.pts[ia].t}|${d.pts[ib].t}`, () => {
          const cs = bars(d.pts[ia].t, d.pts[ib].t);
          if (!cs || cs.length < 2) return cs ? false : null;
          const n = cs.length; let sx = 0, sy = 0, sxy = 0, sxx = 0;
          cs.forEach((c, i) => { sx += i; sy += c.close; sxy += i * c.close; sxx += i * i; });
          const m = (n * sxy - sx * sy) / (n * sxx - sx * sx || 1), b0 = (sy - m * sx) / n;
          let ss = 0; cs.forEach((c, i) => { ss += (c.close - (b0 + m * i)) ** 2; });
          return { m, b0, sd: Math.sqrt(ss / n), n, ta: cs[0].time, tb: cs[n - 1].time };
        });
        if (!r) return noData(P, r === null ? 'No bar data' : 'Not enough bars');
        const xa = X(r.ta), xb = X(r.tb), k = d.dev || 2, pA = r.b0, pB = r.b0 + r.m * (r.n - 1);
        const line = (o) => extend({ x: xa, y: Y(pA + o) }, { x: xb, y: Y(pB + o) }, false, d.extR);
        const mL = line(0), up = line(k * r.sd), dn = line(-k * r.sd);
        const f = fillA(0.08); if (f) PL([up.a, up.b, dn.b, dn.a], { close: true, fill: f, stroke: false, nohit: true });
        L(up.a, up.b); L(dn.a, dn.b); L(mL.a, mL.b, { dash: 1 });
        g.handles = []; g.handles[ia] = { x: xa, y: Y(pA) }; g.handles[ib] = { x: xb, y: Y(pB) };
      },
      flatchannel(d, g, P) {
        const y2 = (P[2] || P[1]).y, f = fillA(0.1);
        if (f) PL([P[0], P[1], { x: P[1].x, y: y2 }, { x: P[0].x, y: y2 }], { close: true, fill: f, stroke: false, nohit: true });
        L(P[0], P[1]); L({ x: P[0].x, y: y2 }, { x: P[1].x, y: y2 });
        g.handles = [P[0], P[1], { x: (P[0].x + P[1].x) / 2, y: y2 }];
      },
      disjoint(d, g, P) {
        const p2 = P[2] || P[1], a = { x: P[0].x, y: p2.y }, b = { x: P[1].x, y: p2.y - (P[1].y - P[0].y) }, f = fillA(0.1);
        if (f) PL([P[0], P[1], b, a], { close: true, fill: f, stroke: false, nohit: true });
        L(P[0], P[1]); L(a, b);
        g.handles = [P[0], P[1], a];
      },
      pitchfork,
      fib(d, g, P, w) {
        const x1 = d.extL ? 0 : Math.min(P[0].x, P[1].x), x2 = d.extR ? w : Math.max(P[0].x, P[1].x);
        const lv = d.levels || (d.more ? LV.retMore : LV.ret);
        hLevels(lv, (v) => d.pts[1].p + (d.pts[0].p - d.pts[1].p) * v, x1, x2, true);
        L(P[0], P[1], { c: alpha(d.color, 0.8), dash: [4, 4], w: 1 });
      },
      fibext(d, g, P, w) {
        const A = d.pts[0], B = d.pts[1], C = d.pts[2] || d.pts[1], pc = P[2] || P[1];
        const xs = d.extL ? 0 : pc.x, xe = d.extR ? w : pc.x + Math.max(Math.abs(P[1].x - P[0].x), 80);
        if (d.pts.length >= 3) hLevels(d.more ? LV.extMore : LV.ext, (v) => C.p + (B.p - A.p) * v, xs, xe, true);
        PL(P, { w: 1, dash: 1 });
      },
      fibchannel(d, g, P) {
        const p2 = P[2] || P[1], dx = P[1].x - P[0].x, slope = dx ? (P[1].y - P[0].y) / dx : 0, off = p2.y - (P[0].y + slope * (p2.x - P[0].x));
        const lv = d.more ? LV.retMore : LV.ret, ls = lv.map((v, i) => ({ v, c: fibColor(v, i), s: extend({ x: P[0].x, y: P[0].y + off * v }, { x: P[1].x, y: P[1].y + off * v }, d.extL, d.extR) }));
        for (let i = 1; i < ls.length; i++) PL([ls[i - 1].s.a, ls[i - 1].s.b, ls[i].s.b, ls[i].s.a], { close: true, fill: alpha(ls[i].c, 0.07), stroke: false, nohit: true });
        for (const o of ls) { L(o.s.a, o.s.b, { c: o.c, w: 1 }); TX(String(o.v), Math.min(P[0].x, P[1].x) - 4, (P[0].x < P[1].x ? P[0].y : P[1].y) + off * o.v, { align: 'right', fg: o.c, size: 11, nohit: true, avoid: true }); }
        g.handles = [P[0], P[1], { x: (P[0].x + P[1].x) / 2, y: (P[0].y + P[1].y) / 2 + off }];
      },
      fibtime(d, g, P, w, h) {
        const dx = P[1].x - P[0].x;
        LV.zones.forEach((k, i) => {
          const x = P[0].x + k * dx;
          if ((i && Math.abs(dx) < 1) || x < -50 || x > w + 50) return;
          const c = PAL[(i + 1) % PAL.length];
          L({ x, y: 0 }, { x, y: h }, { c, w: 1 });
          TX(String(k), x + 3, h - 14, { align: 'left', fg: c, size: 11, nohit: true, avoid: true });
        });
        L(P[0], P[1], { w: 1, dash: 1, nohit: true });
      },
      fibfan(d, g, P) {
        const [A, B] = P, dx = B.x - A.x, dy = B.y - A.y;
        R(A.x, A.y, dx, dy, { w: 1, dash: 2, c: alpha(d.color, 0.5), nohit: true });
        (d.more ? LV.fanMore : LV.fan).forEach((v, i) => {
          const c = fibColor(v, i), q1 = { x: B.x, y: A.y + dy * v }, q2 = { x: A.x + dx * v, y: B.y };
          if (v > 0) { L(A, ray(A, q1), { c, w: 1 }); TX(String(v), B.x + 4, q1.y, { align: 'left', fg: c, size: 10.5, nohit: true, avoid: true }); }
          if (v > 0 && v < 1) { L(A, ray(A, q2), { c, w: 1 }); TX(String(v), q2.x, B.y + (dy > 0 ? 10 : -10), { fg: c, size: 10.5, nohit: true, avoid: true }); }
        });
      },
      fibtimetrend(d, g, P, w, h) {
        if (P.length >= 3) {
          const dx = P[1].x - P[0].x;
          (d.more ? LV.timeMore : LV.time).forEach((v, i) => {
            const x = P[2].x + dx * v; if (x < -50 || x > w + 50) return;
            const c = fibColor(v, i); L({ x, y: 0 }, { x, y: h }, { c, w: 1 }); TX(String(v), x + 3, h - 14, { align: 'left', fg: c, size: 11, nohit: true, avoid: true });
          });
        }
        PL(P, { w: 1, dash: 1 });
      },
      fibcircles(d, g, P) {
        const r = hyp(P[0], P[1]);
        (d.more ? LV.circMore : LV.circ).forEach((v, i) => { const c = fibColor(v, i); E(P[0].x, P[0].y, r * v, r * v, { c, w: 1 }); TX(String(v), P[0].x, P[0].y - r * v - 1, { base: 'bottom', fg: c, size: 10.5, nohit: true, avoid: true }); });
        L(P[0], P[1], { w: 1, dash: 1, nohit: true });
      },
      fibspiral(d, g, P) {
        const r0 = hyp(P[0], P[1]), a0 = Math.atan2(P[1].y - P[0].y, P[1].x - P[0].x), phi = 1.6180339887, pts = [];
        if (r0 < 1) return;
        for (let th = -4 * Math.PI; th <= 2.5 * Math.PI; th += Math.PI / 40) { const r = r0 * Math.pow(phi, th / (Math.PI / 2)); pts.push({ x: P[0].x + r * Math.cos(a0 + th), y: P[0].y + r * Math.sin(a0 + th) }); }
        PL(pts); L(P[0], P[1], { w: 1, dash: 1, nohit: true });
      },
      fibarcs(d, g, P) {
        const r = hyp(P[0], P[1]), up = P[1].y <= P[0].y, a0 = up ? Math.PI : 0, a1 = up ? TAU : Math.PI;
        (d.more ? LV.circMore : LV.circ).forEach((v, i) => { const c = fibColor(v, i); E(P[0].x, P[0].y, r * v, r * v, { a0, a1, c, w: 1 }); TX(String(v), P[0].x, P[0].y + (up ? -1 : 1) * r * v, { base: up ? 'bottom' : 'top', fg: c, size: 10.5, nohit: true, avoid: true }); });
        L(P[0], P[1], { w: 1, dash: 1 });
      },
      fibwedge(d, g, P) {
        const O = P[0], r = hyp(O, P[1]), a1 = Math.atan2(P[1].y - O.y, P[1].x - O.x), p2 = P[2] || P[1], a2 = Math.atan2(p2.y - O.y, p2.x - O.x);
        const ccw = normA(a2 - a1) > Math.PI, Q = { x: O.x + r * Math.cos(a2), y: O.y + r * Math.sin(a2) };
        L(O, P[1]); L(O, Q);
        (d.more ? LV.circMore.slice(0, 7) : LV.circ).forEach((v, i) => { const c = fibColor(v, i); E(O.x, O.y, r * v, r * v, { a0: a1, a1: a2, ccw, c, w: 1 }); TX(String(v), O.x + r * v * Math.cos(a1), O.y + r * v * Math.sin(a1) - 7, { fg: c, size: 10.5, nohit: true, avoid: true }); });
        g.handles = [O, P[1], Q];
      },
      pitchfan(d, g, P) {
        const O = P[0], B = P[1], C = P[2] || P[1];
        [0, 0.382, 0.5, 0.618, 1].forEach((k, i) => { const q = lerp(B, C, k); if (hyp(O, q) > 1) L(O, ray(O, q), { c: k === 0.5 ? d.color : fibColor(k, i + 2), w: k === 0.5 ? undefined : 1 }); });
        L(B, C, { w: 1 });
      },
      gannbox(d, g, P) {
        const [A, B] = P, dx = B.x - A.x, dy = B.y - A.y;
        LV.gann.forEach((v, i) => {
          const c = fibColor(v, i + 1), x = A.x + dx * v, y = A.y + dy * v;
          if (i) R(A.x + dx * LV.gann[i - 1], A.y, dx * (v - LV.gann[i - 1]), dy, { fill: alpha(c, 0.06), stroke: false, nohit: true });
          L({ x, y: A.y }, { x, y: B.y }, { c, w: 1 }); L({ x: A.x, y }, { x: B.x, y }, { c, w: 1 });
          TX(String(v), Math.min(A.x, B.x) - 4, y, { align: 'right', fg: c, size: 10.5, nohit: true, avoid: true });
          TX(String(v), x, Math.max(A.y, B.y) + 9, { fg: c, size: 10.5, nohit: true, avoid: true });
        });
        L(A, B, { w: 1, dash: 1, nohit: true }); L({ x: A.x, y: B.y }, { x: B.x, y: A.y }, { w: 1, dash: 1, nohit: true });
      },
      gannsquare: gannSquare(false),
      gannsqfixed: gannSquare(true),
      gannfan(d, g, P) {
        const [A, B] = P, dx = B.x - A.x, dy = B.y - A.y;
        [[1, 8], [1, 4], [1, 3], [1, 2], [1, 1], [2, 1], [3, 1], [4, 1], [8, 1]].forEach(([a, b], i) => {
          const q = { x: A.x + dx * b, y: A.y + dy * a }, c = a === b ? d.color : PAL[(i + 1) % PAL.length];
          if (hyp(A, q) < 1) return;
          L(A, ray(A, q), { c, w: a === b ? undefined : 1 });
          const len = hyp(A, q), Rl = Math.max(hyp(A, B) * 1.2, 50), lab = { x: A.x + ((q.x - A.x) / len) * Rl, y: A.y + ((q.y - A.y) / len) * Rl };
          TX(`${a}/${b}`, lab.x + 3, lab.y, { align: 'left', fg: c, size: 10.5, nohit: true, avoid: true });
        });
      },
      xabcd: pattern, cypher: pattern, abcd: pattern, hs: pattern, trianglepat: pattern, threedrives: pattern,
      ewimpulse: wave, ewcorrection: wave, ewtriangle: wave, ewdouble: wave, ewtriple: wave,
      cycliclines(d, g, P, w, h) {
        const dx = P[1].x - P[0].x;
        if (Math.abs(dx) < 3) L({ x: P[0].x, y: 0 }, { x: P[0].x, y: h });
        else for (let k = 0, x = P[0].x; k < 400 && x >= -5 - Math.abs(dx) && x <= w + 5 + Math.abs(dx); k++, x = P[0].x + k * dx) L({ x, y: 0 }, { x, y: h }, { w: k ? 1 : undefined });
        L(P[0], P[1], { w: 1, dash: 1, nohit: true });
      },
      timecycles(d, g, P, w) {
        const dx = P[1].x - P[0].x, rx = Math.abs(dx) / 2, ry = Math.abs(P[1].y - P[0].y) > 4 ? Math.abs(P[1].y - P[0].y) : rx, up = P[1].y <= P[0].y;
        if (rx < 2) return L(P[0], P[1]);
        const step = Math.abs(dx), start = Math.min(P[0].x, P[1].x);
        for (let k = 0, x = start; k < 300 && x <= w + step; k++, x = start + k * step) E(x + rx, P[0].y, rx, ry, { a0: up ? Math.PI : 0, a1: up ? TAU : Math.PI });
        L({ x: start, y: P[0].y }, { x: w, y: P[0].y }, { w: 1, dash: 2, nohit: true });
      },
      sineline(d, g, P, w) {
        const dx = P[1].x - P[0].x, ym = (P[0].y + P[1].y) / 2, A = (P[0].y - P[1].y) / 2;
        if (Math.abs(dx) < 2) return L(P[0], P[1]);
        const pts = []; for (let x = 0; x <= w + 2; x += 2) pts.push({ x, y: ym + A * Math.cos((Math.PI * (x - P[0].x)) / dx) });
        PL(pts);
      },
      long: position, short: position,
      forecast(d, g, P) {
        const dp = d.pts[1].p - d.pts[0].p, c = dp >= 0 ? TEAL : RED;
        L(P[0], { x: P[1].x, y: P[0].y }, { w: 1, dash: 1, nohit: true });
        L(P[0], P[1]); arrowHead(P[0], P[1]); dot(P[0], 3.5); dot(P[1], 3.5, c);
        TX(`${sgn(dp)}${host.fmt(dp)} (${pctTxt(dp, d.pts[0].p)}%)\n${host.bars(d.pts[0].t, d.pts[1].t)} bars · ${host.dur(Math.abs(d.pts[1].t - d.pts[0].t))}\n${host.fmt(d.pts[1].p)}`, P[1].x, P[1].y + (dp >= 0 ? -10 : 10), { bg: alpha(c, 0.9), base: dp >= 0 ? 'bottom' : 'top', nohit: true });
      },
      barspattern(d, g, P) {
        const bs = d.bars;
        if (!bs || !bs.length) return noData(P, !bs ? (D === S.draft ? '' : 'Bars pattern') : host.candles ? 'No bars in range' : 'No bar data');
        const n = bs.length, off = d.pts[0].p - bs[0][0], dx = n > 1 ? (P[1].x - P[0].x) / (n - 1) : 0, bw = Math.max(1, Math.abs(dx) * 0.6);
        for (let i = 0; i < n; i++) {
          const b = bs[i], x = P[0].x + i * dx;
          G.prims.push({ k: 'C', x, bw, yo: Y(b[0] + off), yh: Y(b[1] + off), yl: Y(b[2] + off), yc: Y(b[3] + off), up: b[3] >= b[0], cu: alpha(d.color, 0.85), cd: alpha(d.color, 0.4) });
        }
        g.handles = [P[0], { x: P[1].x, y: Y(bs[n - 1][3] + off) }];
      },
      ghostfeed(d, g, P) {
        PL(P, { w: 1, dash: 2 });
        if (P.length < 2) return;
        const gen = cached(d, d.pts.map((q) => `${q.t},${q.p}`).join(';'), () => {
          const rnd = seeded(d.id), segs = [];
          let tot = 0;
          for (let i = 1; i < d.pts.length; i++) { const nb = Math.min(300, Math.max(1, Math.abs(host.bars(d.pts[i - 1].t, d.pts[i].t)))); segs.push(nb); tot += nb; }
          const hist = host.tfSec ? bars(d.pts[0].t - 50 * host.tfSec, d.pts[0].t) : null;
          let vol = hist && hist.length ? hist.reduce((a, c) => a + (c.high - c.low), 0) / hist.length : 0;
          if (!(vol > 0)) vol = Math.max(Math.abs(d.pts[d.pts.length - 1].p - d.pts[0].p) / tot * 1.5, Math.abs(d.pts[0].p) * 0.001);
          const out = []; let prev = d.pts[0].p;
          segs.forEach((nb, s) => {
            for (let j = 1; j <= nb; j++) {
              const target = d.pts[s].p + (d.pts[s + 1].p - d.pts[s].p) * (j / nb), o = prev, c = target + (rnd() - 0.5) * vol * 0.6;
              out.push({ s, f: (j - 0.5) / nb, o, c, h: Math.max(o, c) + rnd() * vol * 0.4, l: Math.min(o, c) - rnd() * vol * 0.4 });
              prev = c;
            }
          });
          return out;
        });
        for (const b of gen) {
          const a = P[b.s], z = P[b.s + 1], x = a.x + (z.x - a.x) * b.f;
          G.prims.push({ k: 'C', x, bw: 0, yo: Y(b.o), yh: Y(b.h), yl: Y(b.l), yc: Y(b.c), up: b.c >= b.o, cu: alpha(TEAL, 0.55), cd: alpha(RED, 0.55), nohit: true });
        }
        let px = Infinity; for (let i = 1; i < P.length; i++) { const k = Math.abs(host.bars(d.pts[i - 1].t, d.pts[i].t)) || 1; px = Math.min(px, Math.abs(P[i].x - P[i - 1].x) / k); }
        const bw = Math.max(1, Math.min(14, px * 0.6)); for (const pr of G.prims) if (pr.k === 'C') pr.bw = bw;
      },
      sector(d, g, P) {
        const O = P[0], r = hyp(O, P[1]), a1 = Math.atan2(P[1].y - O.y, P[1].x - O.x), p2 = P[2] || P[1], a2 = Math.atan2(p2.y - O.y, p2.x - O.x);
        const Q = { x: O.x + r * Math.cos(a2), y: O.y + r * Math.sin(a2) };
        E(O.x, O.y, r, r, { a0: a1, a1: a2 === a1 ? a1 + 1e-6 : a2, ccw: normA(a2 - a1) > Math.PI, pie: true, fill: fillA(0.15) });
        const deg = (normA(a2 - a1) > Math.PI ? TAU - normA(a2 - a1) : normA(a2 - a1)) * 180 / Math.PI;
        TX(`${deg.toFixed(1)}°`, O.x, O.y - 10, { fg: d.color, nohit: true, base: 'bottom' });
        g.handles = [O, P[1], Q];
      },
      avwap(d, g, P, w) {
        const r = cached(d, String(d.pts[0].t), () => {
          const cs = bars(d.pts[0].t, FAR); if (!cs || !cs.length) return cs;
          let pv = 0, vv = 0; const vs = cs.map((c) => { const v = c.volume > 0 ? c.volume : 1; pv += ((c.high + c.low + c.close) / 3) * v; vv += v; return pv / vv; });
          return { vs, ta: cs[0].time, tb: cs[cs.length - 1].time };
        });
        if (!r || !r.vs) { dot(P[0], 4); TX(r === null ? 'VWAP · no bar data' : 'VWAP', P[0].x + 8, P[0].y, { align: 'left', fg: d.color, nohit: true }); return; }
        const n = r.vs.length, xa = X(r.ta), xb = X(r.tb), dx = n > 1 ? (xb - xa) / (n - 1) : 0, step = dx > 0 && dx < 1 ? Math.ceil(1 / dx) : 1, pts = [];
        for (let i = 0; i < n; i += step) { const x = xa + i * dx; if (x < -dx * step - 5) continue; if (x > w + 5) break; pts.push({ x, y: Y(r.vs[i]) }); }
        if (n > 1 && (n - 1) % step) { const x = xb; if (x <= w + 5) pts.push({ x, y: Y(r.vs[n - 1]) }); }
        if (pts.length === 1) pts.push({ x: pts[0].x + 1, y: pts[0].y });
        if (pts.length) PL(pts);
        const last = pts[pts.length - 1];
        if (last) TX(`VWAP ${host.fmt(r.vs[n - 1])}`, last.x + 4, last.y, { align: 'left', bg: alpha(d.color, 0.85), size: 11, nohit: true });
        g.handles = [{ x: xa, y: Y(r.vs[0]) }];
      },
      fixedvp: profileTool(true),
      anchoredvp: profileTool(false),
      pricerange(d, g, P) {
        const dp = d.pts[1].p - d.pts[0].p, c = dp >= 0 ? BLUE : RED, mx = (P[0].x + P[1].x) / 2;
        R(P[0].x, P[0].y, P[1].x - P[0].x, P[1].y - P[0].y, { fill: alpha(c, 0.15), stroke: false });
        L({ x: P[0].x, y: P[0].y }, { x: P[1].x, y: P[0].y }, { c, w: 1 }); L({ x: P[0].x, y: P[1].y }, { x: P[1].x, y: P[1].y }, { c, w: 1 });
        L({ x: mx, y: P[0].y }, { x: mx, y: P[1].y }, { c, w: 1 }); arrowHead({ x: mx, y: P[0].y }, { x: mx, y: P[1].y }, 8, { c, w: 1 });
        TX(`${sgn(dp)}${host.fmt(dp)} (${pctTxt(dp, d.pts[0].p)}%)`, mx, P[1].y + (dp >= 0 ? -8 : 8), { bg: alpha(c, 0.9), base: dp >= 0 ? 'bottom' : 'top', nohit: true });
      },
      daterange(d, g, P) {
        const fwd = d.pts[1].t >= d.pts[0].t, c = fwd ? BLUE : RED, my = (P[0].y + P[1].y) / 2;
        R(P[0].x, P[0].y, P[1].x - P[0].x, P[1].y - P[0].y, { fill: alpha(c, 0.15), stroke: false });
        L({ x: P[0].x, y: P[0].y }, { x: P[0].x, y: P[1].y }, { c, w: 1 }); L({ x: P[1].x, y: P[0].y }, { x: P[1].x, y: P[1].y }, { c, w: 1 });
        L({ x: P[0].x, y: my }, { x: P[1].x, y: my }, { c, w: 1 }); arrowHead({ x: P[0].x, y: my }, { x: P[1].x, y: my }, 8, { c, w: 1 });
        TX(`${host.bars(d.pts[0].t, d.pts[1].t)} bars, ${host.dur(Math.abs(d.pts[1].t - d.pts[0].t))}`, (P[0].x + P[1].x) / 2, Math.max(P[0].y, P[1].y) + 8, { bg: alpha(c, 0.9), base: 'top', nohit: true });
      },
      measure(d, g, P) {
        const up = d.pts[1].p >= d.pts[0].p, c = up ? BLUE : RED, mx = (P[0].x + P[1].x) / 2, my = (P[0].y + P[1].y) / 2;
        R(P[0].x, P[0].y, P[1].x - P[0].x, P[1].y - P[0].y, { fill: alpha(c, 0.18), stroke: false });
        L({ x: mx, y: P[0].y }, { x: mx, y: P[1].y }, { c, w: 1, dash: 0 }); L({ x: P[0].x, y: my }, { x: P[1].x, y: my }, { c, w: 1, dash: 0 });
        const dp = d.pts[1].p - d.pts[0].p, top = Math.min(P[0].y, P[1].y), bot = Math.max(P[0].y, P[1].y);
        TX(`${sgn(dp)}${host.fmt(dp)} (${pctTxt(dp, d.pts[0].p)}%)\n${host.bars(d.pts[0].t, d.pts[1].t)} bars, ${host.dur(Math.abs(d.pts[1].t - d.pts[0].t))}`, mx, up ? top - 8 : bot + 8, { bg: alpha(c, 0.9), base: up ? 'bottom' : 'top', nohit: true });
      },
      brush(d, g, P) { PL(P, { cap: 'round', dash: 0 }); g.handles = []; },
      highlighter(d, g, P) { PL(P, { cap: 'round', dash: 0, c: alpha(d.color, 0.35), w: d.width || 14, flat: true }); g.handles = []; },
      arrowmarker(d, g, P) {
        const [A, B] = P, len = hyp(A, B); if (len < 2) return;
        const ux = (B.x - A.x) / len, uy = (B.y - A.y) / len, nx = -uy, ny = ux, hl = Math.min(22, len * 0.5), sw = 4, hw = 11;
        const at = (k, o) => ({ x: A.x + ux * k + nx * o, y: A.y + uy * k + ny * o });
        PL([at(0, -sw), at(len - hl, -sw), at(len - hl, -hw), B, at(len - hl, hw), at(len - hl, sw), at(0, sw)], { close: true, fill: d.color, stroke: false });
        if (d.text) TX(d.text, A.x - ux * 8, A.y - uy * 8, { fg: d.color, align: ux > 0 ? 'right' : 'left', nohit: true, size: d.size || 12 });
      },
      arrowup(d, g, P) { glyphArrow(d, g, P[0], 1); },
      arrowdown(d, g, P) { glyphArrow(d, g, P[0], -1); },
      rect(d, g, P) { R(P[0].x, P[0].y, P[1].x - P[0].x, P[1].y - P[0].y, { fill: fillA(0.18) }); },
      rotrect(d, g, P) {
        const [A, B] = P, C = P[2] || P[1], len = hyp(A, B) || 1, nx = -(B.y - A.y) / len, ny = (B.x - A.x) / len, off = (C.x - A.x) * nx + (C.y - A.y) * ny;
        const B2 = { x: B.x + nx * off, y: B.y + ny * off }, A2 = { x: A.x + nx * off, y: A.y + ny * off };
        PL([A, B, B2, A2], { close: true, fill: fillA(0.18) });
        g.handles = [A, B, mid(A2, B2)];
      },
      path(d, g, P) { PL(P, { join: 'round' }); if (P.length > 1) arrowHead(P[P.length - 2], P[P.length - 1], 11); },
      polyline(d, g, P) { PL(P, { close: d.fill !== false && P.length > 2, fill: d.fill === false || P.length < 3 ? null : alpha(d.color, 0.18), join: 'round' }); },
      circle(d, g, P) { const r = hyp(P[0], P[1]); E(P[0].x, P[0].y, r, r, { fill: fillA(0.15) }); },
      ellipse(d, g, P) { E((P[0].x + P[1].x) / 2, (P[0].y + P[1].y) / 2, Math.abs(P[1].x - P[0].x) / 2, Math.abs(P[1].y - P[0].y) / 2, { fill: fillA(0.15) }); },
      triangle(d, g, P) { PL(P.length > 2 ? P : [P[0], P[1]], { close: P.length > 2, fill: P.length > 2 ? fillA(0.18) : null }); },
      arc(d, g, P) {
        const C = P[2], cc = C && circumcircle(P[0], C, P[1]);
        if (!cc) return PL([P[0], C || P[1], P[1]]);
        const a0 = Math.atan2(P[0].y - cc.y, P[0].x - cc.x), a1 = Math.atan2(P[1].y - cc.y, P[1].x - cc.x), am = Math.atan2(C.y - cc.y, C.x - cc.x);
        E(cc.x, cc.y, cc.r, cc.r, { a0, a1, ccw: !angleIn(am, a0, a1, false), fill: fillA(0.15) });
      },
      curve(d, g, P) { PL(bezier(P[0], P[2] || mid(P[0], P[1]), null, P[1])); if (P[2]) L(P[0], P[2], { w: 1, dash: 2, c: alpha(d.color, active(d) ? 0.5 : 0), nohit: true }); },
      doublecurve(d, g, P) { const c1 = P[2] || mid(P[0], P[1]), m = mid(P[0], P[1]); PL(bezier(P[0], c1, { x: 2 * m.x - c1.x, y: 2 * m.y - c1.y }, P[1])); },
      text(d, g, P, w, h) {
        const size = d.size || 14, q = d.type === 'anchoredtext' && d.fx != null ? { x: d.fx * w, y: d.fy * h } : P[0];
        const pr = TX(d.text || '', q.x, q.y - size, { size, align: 'left', base: 'top', pad: 0, fg: d.color, minW: 10, bg: d.bg ? alpha(d.color, 0.15) : null });
        if (active(d)) R(pr.bx - 4, pr.by - 2, pr.bw + 8, pr.bh + 4, { c: alpha(d.color, 0.6), dash: [3, 3], w: 1, nohit: true });
        G.box = pr; G.textAt = { x: q.x, y: q.y - size - 4, size }; g.handles = [];
        if (d.type === 'anchoredtext') g.P = [q];
      },
      note(d, g, P) { noteAt(d, g, P[0]); },
      anchorednote(d, g, P, w, h) { const q = d.fx != null ? { x: d.fx * w, y: d.fy * h } : P[0]; noteAt(d, g, q); g.P = [q]; },
    };
    function noteAt(d, g, q) {
      R(q.x - 8, q.y - 8, 16, 16, { fill: d.color, stroke: false });
      PL([{ x: q.x - 4, y: q.y - 3 }, { x: q.x + 4, y: q.y - 3 }], { c: '#000', w: 1, dash: 0, nohit: true }); PL([{ x: q.x - 4, y: q.y + 1 }, { x: q.x + 2, y: q.y + 1 }], { c: '#000', w: 1, dash: 0, nohit: true });
      if (d.text) textAt(TX(d.text, q.x, q.y - 14, { base: 'bottom', bg: alpha(d.color, 0.92), fg: '#131722', size: d.size || 12 }), d.size || 12);
      else G.textAt = { x: q.x - 8, y: q.y - 40, size: 12 };
      g.handles = [];
    }
    Object.assign(BUILD, {
      pricenote(d, g, P) {
        dot(P[0], 3.5); L(P[0], P[1], { w: 1 });
        const pr = TX(`${host.fmt(d.pts[0].p)}${d.text ? '\n' + d.text : ''}`, P[1].x, P[1].y, { bg: d.color, base: P[1].y < P[0].y ? 'bottom' : 'top', size: d.size || 12 });
        textAt(pr, d.size || 12);
      },
      pin(d, g, P) {
        const q = P[0];
        PL([{ x: q.x - 5, y: q.y - 13 }, q, { x: q.x + 5, y: q.y - 13 }], { close: true, fill: d.color, stroke: false });
        E(q.x, q.y - 18, 7.5, 7.5, { fill: d.color, stroke: false }); E(q.x, q.y - 18, 2.5, 2.5, { fill: '#fff', stroke: false, nohit: true });
        if (d.text && (active(d) || d.open)) textAt(TX(d.text, q.x, q.y - 30, { base: 'bottom', bg: alpha('#1e222d', 0.95), fg: GREY, border: d.color, size: d.size || 12 }), d.size || 12);
        else G.textAt = { x: q.x - 8, y: q.y - 50, size: 12 };
        g.handles = [];
      },
      table(d, g, P) {
        const size = d.size || 12, font = `${size}px ${FONT}`, rows = String(d.text || '').split('\n').map((r) => r.split(/\s*[|\t]\s*/));
        const nc = Math.max(2, ...rows.map((r) => r.length)), cw = Array(nc).fill(40), rh = Math.round(size * 1.9), q = P[0];
        rows.forEach((r) => r.forEach((c, i) => { cw[i] = Math.max(cw[i], textW(c, font) + 16); }));
        const W = cw.reduce((a, b) => a + b, 0);
        R(q.x, q.y, W, rh * rows.length, { fill: alpha(d.color, 0.1), w: 1 });
        R(q.x, q.y, W, rh, { fill: alpha(d.color, 0.3), stroke: false, nohit: true });
        rows.forEach((r, ri) => {
          if (ri) L({ x: q.x, y: q.y + ri * rh }, { x: q.x + W, y: q.y + ri * rh }, { w: 1, dash: 0, c: alpha(d.color, 0.6), nohit: true });
          let x = q.x;
          for (let i = 0; i < nc; i++) { if (r[i]) TX(r[i], x + 8, q.y + ri * rh + rh / 2, { align: 'left', fg: GREY, size, nohit: true, bold: ri === 0, pad: 0 }); x += cw[i]; if (i < nc - 1) L({ x, y: q.y }, { x, y: q.y + rh * rows.length }, { w: 1, dash: 0, c: alpha(d.color, 0.6), nohit: true }); }
        });
        G.box = { bx: q.x, by: q.y, bw: W, bh: rh * rows.length }; G.textAt = { x: q.x, y: q.y, size }; g.handles = [];
      },
      callout(d, g, P) {
        const pr = TX(d.text || ' ', P[1].x, P[1].y, { bg: alpha(d.color, 0.92), size: d.size || 12, pad: 8 });
        const cx = pr.bx + pr.bw / 2, cy = pr.by + pr.bh / 2, dx = P[0].x - cx, dy = P[0].y - cy, len = Math.hypot(dx, dy) || 1, nx = (-dy / len) * 8, ny = (dx / len) * 8;
        PL([{ x: cx + nx, y: cy + ny }, P[0], { x: cx - nx, y: cy - ny }], { close: true, fill: alpha(d.color, 0.92), stroke: false });
        G.prims.push(G.prims.splice(G.prims.indexOf(pr), 1)[0]);
        textAt(pr, d.size || 12);
      },
      pricelabel(d, g, P) {
        const q = P[0], pr = TX(d.text || host.fmt(d.pts[0].p), q.x + 10, q.y - 10, { align: 'left', base: 'bottom', bg: d.color, size: d.size || 12, bold: true });
        PL([q, { x: pr.bx, y: pr.by + pr.bh - 6 }, { x: pr.bx + 10, y: pr.by + pr.bh }], { close: true, fill: d.color, stroke: false });
        G.box = pr; g.handles = [];
      },
      signpost(d, g, P) {
        const q = P[0], top = { x: q.x, y: q.y - 52 };
        L(q, top, { w: 1.5, dash: 0 }); dot(q, 3);
        textAt(TX(d.text || ' ', top.x, top.y, { base: 'bottom', bg: d.color, size: d.size || 12, pad: 7 }), d.size || 12);
        g.handles = [];
      },
      flag(d, g, P) {
        const q = P[0];
        L(q, { x: q.x, y: q.y - 26 }, { w: 2, dash: 0 });
        PL([{ x: q.x, y: q.y - 26 }, { x: q.x + 17, y: q.y - 26 }, { x: q.x + 12, y: q.y - 21 }, { x: q.x + 17, y: q.y - 16 }, { x: q.x, y: q.y - 16 }], { close: true, fill: d.color, stroke: false });
        g.handles = [];
      },
      pricetime(d, g, P) {
        const q = P[0], pr = TX(`${host.fmt(d.pts[0].p)}\n${host.fmtTime(d.pts[0].t)}`, q.x + 10, q.y - 10, { align: 'left', base: 'bottom', bg: d.color, size: d.size || 12, bold: true });
        PL([q, { x: pr.bx, y: pr.by + pr.bh - 6 }, { x: pr.bx + 10, y: pr.by + pr.bh }], { close: true, fill: d.color, stroke: false });
        dot(q, 2.5, GREY); G.box = pr; g.handles = [];
      },
      comment(d, g, P) {
        const q = P[0], sz = d.size || 12, f = alpha(d.color, 0.92), pr = TX(d.text || ' ', q.x - 8, q.y - 12, { align: 'left', base: 'bottom', bg: f, size: sz, pad: 7 });
        PL([{ x: pr.bx + 6, y: pr.by + pr.bh - 1 }, q, { x: pr.bx + 18, y: pr.by + pr.bh - 1 }], { close: true, fill: f, stroke: false });
        G.prims.push(G.prims.splice(G.prims.indexOf(pr), 1)[0]);
        textAt(pr, sz); g.handles = [];
      },
      icon(d, g, P) {
        const q = P[0], pr = TX(d.glyph || '⭐', q.x, q.y, { size: d.size || 28, pad: 0, fg: d.color });
        if (active(d)) R(pr.bx - 2, pr.by - 2, pr.bw + 4, pr.bh + 4, { c: alpha(GREY, 0.5), dash: [3, 3], w: 1, nohit: true });
        G.box = pr; g.handles = [q, { x: pr.bx + pr.bw + 2, y: pr.by + pr.bh + 2 }]; g.parts = [0, 'resize'];
      },
      ruler(d, g, P) {
        const [A, B] = P, len = hyp(A, B); L(A, B);
        if (len >= 2) {
          const ux = (B.x - A.x) / len, uy = (B.y - A.y) / len, n = Math.min(400, Math.floor(len / 10));
          for (let i = 0; i <= n; i++) { const k = i * 10, s = i % 5 ? 4 : 8, c = { x: A.x + ux * k, y: A.y + uy * k }; L(c, { x: c.x - uy * s, y: c.y + ux * s }, { w: 1, dash: 0, nohit: true }); }
        }
        const dp = d.pts[1].p - d.pts[0].p, m = mid(A, B);
        TX(`${sgn(dp)}${host.fmt(dp)} (${pctTxt(dp, d.pts[0].p)}%) · ${host.bars(d.pts[0].t, d.pts[1].t)} bars · ${Math.round(len)}px`, m.x, m.y - 12, { bg: 'rgba(42,46,57,.92)', base: 'bottom', nohit: true, size: 11 });
      },
      projection(d, g, P) {
        const A = P[0], B = P[1], C = P[2] || P[1], r = hyp(A, B), a1 = Math.atan2(B.y - A.y, B.x - A.x), a2 = Math.atan2(C.y - A.y, C.x - A.x), ccw = normA(a2 - a1) > Math.PI;
        if (r > 1 && P[2]) {
          E(A.x, A.y, r, r, { a0: a1, a1: a2 === a1 ? a1 + 1e-6 : a2, ccw, pie: true, fill: fillA(0.1), stroke: false });
          [0.382, 0.618, 1].forEach((k, i) => E(A.x, A.y, r * k, r * k, { a0: a1, a1: a2, ccw, w: 1, c: k === 1 ? d.color : fibColor(k, i), nohit: k !== 1 }));
          const den = d.pts[1].p - d.pts[0].p, rt = den ? (d.pts[2].p - d.pts[0].p) / den : 0;
          TX(`${(rt * 100).toFixed(1)}%`, C.x, C.y + (C.y >= A.y ? 8 : -8), { base: C.y >= A.y ? 'top' : 'bottom', bg: alpha(d.color, 0.85), size: 11, nohit: true });
        }
        L(A, B); L(A, C);
      },
      fibext2(d, g, P, w) {
        const A = d.pts[0], B = d.pts[1], xs = d.extL ? 0 : Math.min(P[0].x, P[1].x), xe = d.extR ? w : Math.max(P[0].x, P[1].x) + Math.max(40, Math.abs(P[1].x - P[0].x) * 0.5);
        hLevels(d.more ? LV.extMore : LV.ext, (v) => A.p + (B.p - A.p) * v, xs, xe, true);
        L(P[0], P[1], { c: alpha(d.color, 0.8), dash: [4, 4], w: 1 });
      },
      arrowleft(d, g, P) { glyphArrowH(d, g, P[0], 1); },
      arrowright(d, g, P) { glyphArrowH(d, g, P[0], -1); },
      roundrect(d, g, P) {
        const x0 = Math.min(P[0].x, P[1].x), x1 = Math.max(P[0].x, P[1].x), y0 = Math.min(P[0].y, P[1].y), y1 = Math.max(P[0].y, P[1].y);
        const r = Math.min(12, (x1 - x0) / 4, (y1 - y0) / 4), pts = [];
        [[x1 - r, y0 + r, -Math.PI / 2], [x1 - r, y1 - r, 0], [x0 + r, y1 - r, Math.PI / 2], [x0 + r, y0 + r, Math.PI]].forEach(([cx, cy, a]) => { for (let i = 0; i <= 6; i++) { const th = a + (i / 6) * (Math.PI / 2); pts.push({ x: cx + r * Math.cos(th), y: cy + r * Math.sin(th) }); } });
        PL(pts, { close: true, fill: fillA(0.18), join: 'round' });
      },
      diamond(d, g, P) {
        const cx = (P[0].x + P[1].x) / 2, cy = (P[0].y + P[1].y) / 2;
        PL([{ x: cx, y: P[0].y }, { x: P[1].x, y: cy }, { x: cx, y: P[1].y }, { x: P[0].x, y: cy }], { close: true, fill: fillA(0.18) });
      },
      star(d, g, P) {
        const O = P[0], r = hyp(O, P[1]), a0 = Math.atan2(P[1].y - O.y, P[1].x - O.x), pts = [];
        for (let i = 0; i < 10; i++) { const rr = i % 2 ? r * 0.4 : r, a = a0 + (i * Math.PI) / 5; pts.push({ x: O.x + rr * Math.cos(a), y: O.y + rr * Math.sin(a) }); }
        PL(pts, { close: true, fill: fillA(0.25), join: 'round' });
      },
      xmark(d, g, P) { L(P[0], P[1], { cap: 'round' }); L({ x: P[0].x, y: P[1].y }, { x: P[1].x, y: P[0].y }, { cap: 'round' }); },
      frame(d, g, P) {
        const x0 = Math.min(P[0].x, P[1].x), y0 = Math.min(P[0].y, P[1].y), sz = d.size || 12;
        R(P[0].x, P[0].y, P[1].x - P[0].x, P[1].y - P[0].y, { fill: fillA(0.08) });
        textAt(TX(d.text || 'Frame', x0, y0, { align: 'left', base: 'bottom', bg: d.color, fg: '#131722', size: sz, pad: 5 }), sz);
      },
      hzone(d, g, P, w) {
        const [A, B] = P;
        R(0, A.y, w, B.y - A.y, { fill: fillA(0.15), stroke: false });
        for (const [q, pt] of [[A, d.pts[0]], [B, d.pts[1]]]) { L({ x: 0, y: q.y }, { x: w, y: q.y }, { w: 1 }); TX(host.fmt(pt.p), w - 4, q.y + (q.y <= Math.min(A.y, B.y) ? -8 : 8), { align: 'right', fg: d.color, size: 11, nohit: true }); }
        g.handles = [{ x: Math.min(Math.max(A.x, 20), w - 20), y: A.y }, { x: Math.min(Math.max(B.x, 20), w - 20), y: B.y }];
      },
      vzone(d, g, P, w, h) {
        const [A, B] = P;
        R(A.x, 0, B.x - A.x, h, { fill: fillA(0.12), stroke: false });
        L({ x: A.x, y: 0 }, { x: A.x, y: h }, { w: 1 }); L({ x: B.x, y: 0 }, { x: B.x, y: h }, { w: 1 });
        TX(`${host.bars(d.pts[0].t, d.pts[1].t)} bars`, (A.x + B.x) / 2, 10, { fg: d.color, size: 11, nohit: true });
        g.handles = [{ x: A.x, y: h / 2 }, { x: B.x, y: h / 2 }];
      },
    });
    BUILD.anchoredtext = BUILD.text;
    function position(d, g, P) {
      const yT = Y(d.tp), yS = Y(d.sl);
      if (!Number.isFinite(yT) || !Number.isFinite(yS)) return false;
      const x1 = P[0].x, x2 = P[1].x, yE = P[0].y, x = Math.min(x1, x2), rw = Math.abs(x2 - x1), cx = x + rw / 2;
      R(x, Math.min(yT, yS), rw, Math.abs(yS - yT), { hitOnly: true });
      R(x, yE, rw, yT - yE, { fill: 'rgba(38,166,154,.22)', stroke: false, nohit: true });
      R(x, yE, rw, yS - yE, { fill: 'rgba(239,83,80,.22)', stroke: false, nohit: true });
      L({ x, y: yE }, { x: x + rw, y: yE }, { c: active(d) ? GREY : '#9598a1', w: 1, dash: 0, nohit: true, thin: true });
      const e = d.pts[0].p, rew = Math.abs(d.tp - e), risk = Math.abs(e - d.sl);
      TX(`Target: ${host.fmt(rew)} (${pctTxt(rew, e)}%)  ${host.fmt(d.tp)}`, cx, yT + (yT < yE ? -4 : 4), { bg: 'rgba(38,166,154,.95)', base: yT < yE ? 'bottom' : 'top', nohit: true });
      TX(`Stop: ${host.fmt(risk)} (${pctTxt(risk, e)}%)  ${host.fmt(d.sl)}`, cx, yS + (yS > yE ? 4 : -4), { bg: 'rgba(239,83,80,.95)', base: yS > yE ? 'top' : 'bottom', nohit: true });
      if (active(d)) TX(`${d.type === 'long' ? 'Long' : 'Short'} ${host.fmt(e)} · R:R ${risk ? (rew / risk).toFixed(2) : '∞'}`, cx, yE, { bg: 'rgba(42,46,57,.95)', nohit: true });
      g.handles = [P[0], { x: x2, y: yE }, { x: x1, y: yT }, { x: x1, y: yS }];
      g.parts = ['entry', 'edge', 'tp', 'sl'];
    }
    function glyphArrowH(d, g, q, s) {
      const x0 = q.x + 3 * s;
      PL([{ x: x0, y: q.y }, { x: x0 + 11 * s, y: q.y + 9 }, { x: x0 + 11 * s, y: q.y + 3.5 }, { x: x0 + 24 * s, y: q.y + 3.5 }, { x: x0 + 24 * s, y: q.y - 3.5 }, { x: x0 + 11 * s, y: q.y - 3.5 }, { x: x0 + 11 * s, y: q.y - 9 }], { close: true, fill: d.color, stroke: false });
      if (d.text) TX(d.text, x0 + 28 * s, q.y, { align: s > 0 ? 'left' : 'right', fg: d.color, size: d.size || 12, nohit: true });
      g.handles = [];
    }
    function glyphArrow(d, g, q, dir) {
      const s = dir, y0 = q.y + 3 * s;
      PL([{ x: q.x, y: y0 }, { x: q.x + 9, y: y0 + 11 * s }, { x: q.x + 3.5, y: y0 + 11 * s }, { x: q.x + 3.5, y: y0 + 24 * s }, { x: q.x - 3.5, y: y0 + 24 * s }, { x: q.x - 3.5, y: y0 + 11 * s }, { x: q.x - 9, y: y0 + 11 * s }], { close: true, fill: d.color, stroke: false });
      if (d.text) TX(d.text, q.x, y0 + 28 * s, { base: s > 0 ? 'top' : 'bottom', fg: d.color, size: d.size || 12, nohit: true });
      g.handles = [];
    }

    function geom(d, w, h) {
      const P = d.pts.map(xy);
      if (!P.length || P.some((q) => !q)) return null;
      const g = { P, handles: P.slice(), prims: [], parts: null, box: null, textAt: null, avoid: [] };
      G = g; D = d;
      const build = BUILD[d.type];
      try { if (build && build(d, g, P, w, h) === false) return null; } finally { G = null; D = null; }
      g.bb = bounds(g);
      return g;
    }
    function bounds(g) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      const add = (x, y) => { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; };
      for (const pr of g.prims) {
        switch (pr.k) {
          case 'L': add(pr.a.x, pr.a.y); add(pr.b.x, pr.b.y); break;
          case 'PL': for (const q of pr.pts) add(q.x, q.y); break;
          case 'E': add(pr.x - pr.rx, pr.y - pr.ry); add(pr.x + pr.rx, pr.y + pr.ry); break;
          case 'R': add(pr.x, pr.y); add(pr.x + pr.rw, pr.y + pr.rh); break;
          case 'T': add(pr.bx, pr.by); add(pr.bx + pr.bw, pr.by + pr.bh); break;
          case 'C': add(pr.x - pr.bw, pr.yh); add(pr.x + pr.bw, pr.yl); break;
          default:
        }
      }
      for (const q of g.handles) if (q) add(q.x, q.y);
      return [x0, y0, x1, y1];
    }
    const PAD = 24;
    const offscreen = (bb, w, h) => !(bb[2] >= -PAD && bb[0] <= w + PAD && bb[3] >= -PAD && bb[1] <= h + PAD);

    function hitPrim(pr, p) {
      switch (pr.k) {
        case 'L': return distSeg(p, pr.a, pr.b) < 6;
        case 'PL': {
          const pts = pr.pts, tol = Math.max(6, (pr.w || 0) / 2 + 2);
          for (let i = 1; i < pts.length; i++) if (distSeg(p, pts[i - 1], pts[i]) < tol) return true;
          if (pr.close && pts.length > 2) { if (distSeg(p, pts[pts.length - 1], pts[0]) < tol) return true; if ((pr.fill || pr.hitOnly) && inPoly(p, pts)) return true; }
          return false;
        }
        case 'E': {
          const dx = (p.x - pr.x) / pr.rx, dy = (p.y - pr.y) / pr.ry, rr = Math.hypot(dx, dy), a = Math.atan2(p.y - pr.y, p.x - pr.x);
          const inArc = pr.a0 == null || angleIn(a, pr.a0, pr.a1, pr.ccw);
          if ((pr.fill || pr.hitOnly) && rr <= 1 && inArc) return true;
          return Math.abs(rr - 1) * Math.min(pr.rx, pr.ry) < 6 && inArc;
        }
        case 'R': {
          const inside = p.x >= pr.x - 4 && p.x <= pr.x + pr.rw + 4 && p.y >= pr.y - 4 && p.y <= pr.y + pr.rh + 4;
          if (!inside) return false;
          if (pr.fill || pr.hitOnly) return true;
          return p.x <= pr.x + 4 || p.x >= pr.x + pr.rw - 4 || p.y <= pr.y + 4 || p.y >= pr.y + pr.rh - 4;
        }
        case 'T': return p.x >= pr.bx - 3 && p.x <= pr.bx + pr.bw + 3 && p.y >= pr.by - 3 && p.y <= pr.by + pr.bh + 3;
        case 'C': return Math.abs(p.x - pr.x) <= Math.max(3, pr.bw / 2) && p.y >= Math.min(pr.yh, pr.yl) - 2 && p.y <= Math.max(pr.yh, pr.yl) + 2;
        default: return false;
      }
    }
    function hitOne(d, g, p) {
      for (let i = 0; i < g.handles.length; i++) if (g.handles[i] && hyp(p, g.handles[i]) < 8) return (g.parts || [])[i] ?? i;
      const bb = g.bb;
      if (p.x < bb[0] - 8 || p.x > bb[2] + 8 || p.y < bb[1] - 8 || p.y > bb[3] + 8) return null;
      for (const pr of g.prims) if (!pr.nohit && hitPrim(pr, p)) return 'body';
      return null;
    }
    function hit(p) {
      if (S.hidden) return null;
      ivNow();
      const Ls = cur(), { w, h } = host.pane();
      for (let i = Ls.length - 1; i >= 0; i--) {
        const d = Ls[i];
        if (!shown(d)) continue;
        const g = S.gc.get(d) || geom(d, w, h);
        if (!g) continue;
        const part = hitOne(d, g, p);
        if (part != null) return { d, part };
      }
      return null;
    }

    // ── rendering ────────────────────────────────────
    function draw() {
      const Ls = cur();
      ivNow();
      if (S.set.size && selList().some((d) => !Ls.includes(d) || !shown(d))) setMany(selList().filter((d) => Ls.includes(d) && shown(d)));
      if (S.hover && (!Ls.includes(S.hover) || !shown(S.hover))) S.hover = null;
      notifySel();
      const any = !S.hidden && (Ls.length || S.draft);
      const dpr = window.devicePixelRatio || 1, W = el.clientWidth, Hh = el.clientHeight;
      if (!any && S.blank) { placeToolbar(null); return; }
      if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(Hh * dpr)) {
        canvas.width = Math.round(W * dpr); canvas.height = Math.round(Hh * dpr);
        canvas.style.width = W + 'px'; canvas.style.height = Hh + 'px';
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, Hh);
      S.blank = !any;
      S.gc = new Map();
      if (!any) { placeToolbar(null); return; }
      const { w, h } = host.pane(), bg = host.theme().bg;
      const axis = [];
      const selG = [];
      ctx.save();
      ctx.beginPath(); ctx.rect(0, 0, w, h); ctx.clip();
      const multi = S.set.size > 1;
      const one = (d) => {
        if (d !== S.draft && !shown(d)) return;
        const g = geom(d, w, h);
        if (!g) return;
        if (d !== S.draft) S.gc.set(d, g);
        if (offscreen(g.bb, w, h)) return;
        const act = isSel(d) || d === S.draft;
        render(d, g, act || d === S.hover);
        if (act) {
          if (isSel(d)) selG.push(g);
          ctx.setLineDash([]); ctx.lineWidth = 1.5; ctx.strokeStyle = d.color; ctx.fillStyle = bg;
          for (const q of g.handles) if (q) { ctx.beginPath(); ctx.arc(q.x, q.y, 4.5, 0, TAU); ctx.fill(); ctx.stroke(); }
          if (multi && !g.handles.some(Boolean)) { const b = g.bb; ctx.setLineDash([3, 3]); ctx.lineWidth = 1; ctx.strokeRect(b[0] - 3, b[1] - 3, b[2] - b[0] + 6, b[3] - b[1] + 6); }
          if ((!multi || d === S.sel) && !ANCH[d.type] && d.pts.length <= 8) d.pts.forEach((pt) => axis.push({ p: pt.p, t: pt.t, color: d.color }));
          if (d.type === 'long' || d.type === 'short') axis.push({ p: d.tp, color: TEAL }, { p: d.sl, color: RED });
        } else if (d.type === 'hline' || d.type === 'hray') axis.push({ p: d.pts[0].p, color: d.color });
      };
      if (!S.hidden) { for (const d of Ls) one(d); if (S.draft) one(S.draft); }
      ctx.restore();
      axisLabels(axis, w, h);
      placeToolbar(selG.length ? selG : null);
    }

    function setStroke(pr, d, emph) {
      ctx.strokeStyle = pr.c || d.color;
      ctx.lineWidth = (pr.w ?? d.width ?? 1.5) + (emph && !pr.thin && !pr.flat ? 0.75 : 0);
      ctx.setLineDash(pr.dash == null ? DASH[d.style || 0] || [] : Array.isArray(pr.dash) ? pr.dash : DASH[pr.dash]);
      ctx.lineCap = pr.cap || 'butt'; ctx.lineJoin = pr.join || pr.cap || 'miter';
    }
    function render(d, g, emph) {
      for (const pr of g.prims) {
        if (pr.hitOnly) continue;
        switch (pr.k) {
          case 'L': setStroke(pr, d, emph); ctx.beginPath(); ctx.moveTo(pr.a.x, pr.a.y); ctx.lineTo(pr.b.x, pr.b.y); ctx.stroke(); break;
          case 'PL': {
            if (pr.pts.length < 2) break;
            ctx.beginPath(); pr.pts.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
            if (pr.close) ctx.closePath();
            if (pr.fill) { ctx.fillStyle = pr.fill; ctx.fill(); }
            if (pr.stroke !== false) { setStroke(pr, d, emph); ctx.stroke(); }
            break;
          }
          case 'E': {
            ctx.beginPath();
            if (pr.pie) ctx.moveTo(pr.x, pr.y);
            ctx.ellipse(pr.x, pr.y, pr.rx, pr.ry, 0, pr.a0 ?? 0, pr.a1 ?? TAU, !!pr.ccw);
            if (pr.pie) ctx.closePath();
            if (pr.fill) { ctx.fillStyle = pr.fill; ctx.fill(); }
            if (pr.stroke !== false) { setStroke(pr, d, emph); ctx.stroke(); }
            break;
          }
          case 'R':
            if (pr.fill) { ctx.fillStyle = pr.fill; ctx.fillRect(pr.x, pr.y, pr.rw, pr.rh); }
            if (pr.stroke !== false) { setStroke(pr, d, emph); ctx.strokeRect(pr.x, pr.y, pr.rw, pr.rh); }
            break;
          case 'T': {
            if (pr.bg) { ctx.fillStyle = pr.bg; ctx.beginPath(); ctx.roundRect ? ctx.roundRect(pr.bx, pr.by, pr.bw, pr.bh, 3) : ctx.rect(pr.bx, pr.by, pr.bw, pr.bh); ctx.fill(); }
            if (pr.border) { ctx.strokeStyle = pr.border; ctx.lineWidth = 1; ctx.setLineDash([]); ctx.strokeRect(pr.bx + 0.5, pr.by + 0.5, pr.bw - 1, pr.bh - 1); }
            ctx.font = pr.font; ctx.fillStyle = pr.fg; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
            const oy = pr.by + pr.pad / 2 + (pr.lh - pr.size) / 2;
            for (let i = 0; i < pr.lines.length; i++) ctx.fillText(pr.lines[i], pr.bx + pr.pad, oy + i * pr.lh);
            break;
          }
          case 'C': {
            const col = pr.up ? pr.cu : pr.cd;
            ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = 1; ctx.setLineDash([]);
            ctx.beginPath(); ctx.moveTo(pr.x, pr.yh); ctx.lineTo(pr.x, pr.yl); ctx.stroke();
            ctx.fillRect(pr.x - pr.bw / 2, Math.min(pr.yo, pr.yc), pr.bw, Math.max(1, Math.abs(pr.yc - pr.yo)));
            break;
          }
          default:
        }
      }
      ctx.lineCap = 'butt'; ctx.lineJoin = 'miter';
    }

    function axisLabels(items, w, h) {
      const aw = host.axisWidth(), th = host.timeAxisHeight();
      ctx.font = `11px ${FONT}`; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
      for (const it of items) {
        if (it.p != null) {
          const q = host.toXY(it.t ?? 0, it.p);
          if (q && q.y >= 0 && q.y <= h) {
            ctx.fillStyle = it.color; ctx.fillRect(w + 1, q.y - 9, aw - 2, 18);
            ctx.fillStyle = '#fff'; ctx.fillText(host.fmt(it.p), w + 6, q.y);
          }
        }
        if (it.t != null && th > 0) {
          const q = host.toXY(it.t, it.p ?? 0);
          if (q && q.x >= 0 && q.x <= w) {
            const txt = host.fmtTime(it.t), tw = ctx.measureText(txt).width + 10;
            ctx.fillStyle = it.color; ctx.fillRect(q.x - tw / 2, h + 1, tw, th - 4);
            ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.fillText(txt, q.x, h + th / 2 - 1); ctx.textAlign = 'left';
          }
        }
      }
    }

    // ── style templates (per tool; host.templates {get, set} or in-memory) ──
    const clone = (v) => JSON.parse(JSON.stringify(v));
    const toolKey = (d) => d.tool || d.type;
    const tplAll = () => { try { const v = host.templates ? host.templates.get() : MEM_TPL; return v && typeof v === 'object' ? v : {}; } catch (e) { return {}; } };
    const tplPut = (obj) => { if (host.templates) host.templates.set(obj); else MEM_TPL = obj; };
    const tplOf = (tool) => { const e = tplAll()[tool]; return { list: (e && e.list) || {}, def: (e && e.def) || null }; };
    const styleOf = (d) => { const o = {}; for (const k of STYLE_KEYS) if (d[k] !== undefined && d[k] !== null) o[k] = clone(d[k]); return o; };
    function factoryStyle(tool) {
      const T = TOOLS[tool] || {}, o = { color: T.color || COLORS[0], width: T.width || 1.5, style: 0 };
      if (T.fill) o.fill = true;
      if (T.props) for (const k of STYLE_KEYS) if (k in T.props) o[k] = clone(T.props[k]);
      return o;
    }
    const applyStyle = (d, st) => { for (const k of STYLE_KEYS) delete d[k]; Object.assign(d, factoryStyle(toolKey(d)), clone(st || {})); };
    function tplEdit(tool, fn) {
      const all = clone(tplAll()), e = (all[tool] = all[tool] || { list: {}, def: null });
      e.list = e.list || {}; fn(e);
      if (!Object.keys(e.list).length && !e.def) delete all[tool];
      tplPut(all);
    }
    const tplDefault = (tool) => { const e = tplOf(tool); return e.def && e.list[e.def] ? e.list[e.def] : null; };
    const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

    // ── groups ──
    const nextGroup = () => { const used = new Set(cur().map((d) => d.group)); let i = 1; while (used.has('Group ' + i)) i++; return 'Group ' + i; };
    function groupInto(ds, name) {
      if (name) {
        const m = cur().find((x) => x.group === name && !ds.includes(x));
        for (const d of ds) { d.group = name; if (m && m.gHidden) d.gHidden = true; else delete d.gHidden; if (m && m.gLocked) d.gLocked = true; else delete d.gLocked; touch(d); }
      } else for (const d of ds) { delete d.group; delete d.gHidden; delete d.gLocked; touch(d); }
    }
    const members = (name) => cur().filter((d) => d.group === name);

    // ── floating toolbar for the selected drawing(s) ────
    const POP = 'position:absolute;left:0;top:calc(100% + 4px);display:flex;flex-direction:column;gap:3px;padding:6px;background:var(--panel,#1e222d);border:1px solid var(--line,#2a2e39);border-radius:6px;box-shadow:var(--shadow,0 4px 14px rgba(0,0,0,.4));z-index:8;min-width:210px;white-space:nowrap;cursor:default';
    const ROW = 'display:flex;gap:4px;align-items:center';
    const INP = 'background:var(--bg,#131722);color:var(--text,#d1d4dc);border:1px solid var(--line,#2a2e39);border-radius:4px;height:22px;padding:0 4px;font-size:12px';
    function popHtml(d, ds) {
      if (S.pop === 'tpl' && ds.length === 1) {
        const tool = toolKey(d), e = tplOf(tool), names = Object.keys(e.list);
        return `<div class="tl-pop" data-pop="tpl" style="${POP}"><b style="font-size:11px;opacity:.7">Templates · ${esc(toolOf(d).label || tool)}</b>${names.map((n) => `<div style="${ROW}"><button data-act="tpl-apply" data-v="${esc(n)}" style="flex:1;text-align:left" title="Apply">${esc(n)}</button><button data-act="tpl-def" data-v="${esc(n)}" class="${e.def === n ? 'on' : ''}" title="${e.def === n ? 'Default for new drawings (click to unset)' : 'Use for new drawings'}">${e.def === n ? '★' : '☆'}</button><button data-act="tpl-del" data-v="${esc(n)}" class="danger" title="Delete template">×</button></div>`).join('') || '<i style="font-size:11px;opacity:.6">No saved templates</i>'}<div style="${ROW}"><input data-role="tpl-name" placeholder="Template name" maxlength="40" style="${INP};flex:1;width:110px"><button data-act="tpl-save" title="Save current style as a template">Save as…</button></div><button data-act="tpl-reset" title="${e.def ? 'Apply the default template' : 'Reset to the factory style'}">Apply default</button></div>`;
      }
      if (S.pop === 'vis') {
        const vis = d.visibility || {};
        return `<div class="tl-pop" data-pop="vis" style="${POP}"><b style="font-size:11px;opacity:.7">Visibility on intervals</b>${VIS_UNITS.map((u) => {
          const v = vis[u.k], on = v !== false, r = Array.isArray(v) ? v : u.r;
          return `<label style="${ROW};font-size:12px"><input type="checkbox" data-act="vis-on" data-u="${u.k}" ${on ? 'checked' : ''}><span style="width:62px">${u.label}</span>${u.r ? `<input type="number" data-act="vis-min" data-u="${u.k}" min="${u.r[0]}" max="${u.r[1]}" value="${r[0]}" style="${INP};width:52px" ${on ? '' : 'disabled'}><span>–</span><input type="number" data-act="vis-max" data-u="${u.k}" min="${u.r[0]}" max="${u.r[1]}" value="${r[1]}" style="${INP};width:52px" ${on ? '' : 'disabled'}>` : ''}</label>`;
        }).join('')}<button data-act="vis-reset">Show on all intervals</button></div>`;
      }
      return '';
    }
    function buildToolbar() {
      const ds = selList(), d = S.sel || ds[0];
      if (!d) return;
      const T = toolOf(d), multi = ds.length > 1;
      const sw = COLORS.map((c) => `<button class="sw${c === d.color ? ' on' : ''}" data-act="color" data-v="${c}" style="background:${c}" title="${c}"></button>`).join('');
      const g0 = d.group, grouped = !!g0 && ds.every((x) => x.group === g0);
      const common = [
        `<button data-act="pop" data-v="vis" class="${S.pop === 'vis' ? 'on' : ''}${ds.some((x) => x.visibility) ? ' set' : ''}" title="Visibility on intervals">⏱</button>`,
        `<button data-act="group" class="${grouped ? 'on' : ''}" title="${grouped ? `Ungroup (${esc(g0)})` : 'Group'}">${grouped ? '⊟' : '⊞'}</button>`,
        `<button data-act="hide" title="Hide">👁</button>`,
        `<button data-act="lock" class="${ds.every((x) => x.locked) ? 'on' : ''}" title="${ds.every((x) => x.locked) ? 'Unlock' : 'Lock'}">${ds.every((x) => x.locked) ? '🔒' : '🔓'}</button>`,
        `<button data-act="clone" title="Clone">⧉</button>`,
        `<button data-act="del" class="danger" title="Delete (Del)">🗑</button>`,
      ];
      let parts;
      if (multi) parts = [`<span style="font-size:12px;padding:0 6px;opacity:.8">${ds.length} selected</span>`, `<span class="sws">${sw}</span>`, ...common];
      else {
        const widths = [1, 1.5, 2, 3, 4].concat(d.type === 'highlighter' || d.type === 'brush' ? [6, 10, 14, 20] : []);
        const wv = d.width || 1.5;
        if (!widths.includes(wv)) widths.push(wv);
        const sizes = T.glyph ? [16, 20, 24, 28, 32, 40, 48, 64, 96] : [10, 11, 12, 14, 18, 24, 32], sv = d.size || (T.glyph ? 28 : T.size ? 14 : 12);
        if (!sizes.includes(sv)) sizes.push(sv);
        parts = [
          T.glyph ? '' : `<span class="sws">${sw}</span>`,
          T.line !== false ? `<select data-act="width" title="Line width">${widths.map((v) => `<option ${v === wv ? 'selected' : ''} value="${v}">${v}px</option>`).join('')}</select>` : '',
          T.line !== false && d.type !== 'highlighter' ? `<select data-act="style" title="Line style">${['Solid', 'Dashed', 'Dotted'].map((v, i) => `<option ${i === (d.style || 0) ? 'selected' : ''} value="${i}">${v}</option>`).join('')}</select>` : '',
          T.ext ? `${d.type === 'regression' ? '' : `<button data-act="extL" class="${d.extL ? 'on' : ''}" title="Extend left">⟵</button>`}<button data-act="extR" class="${d.extR ? 'on' : ''}" title="Extend right">⟶</button>` : '',
          T.stats ? `<button data-act="stats" class="${d.showStats ? 'on' : ''}" title="Show price / bars change">Δ</button>` : '',
          T.fill ? `<button data-act="fill" class="${d.fill !== false ? 'on' : ''}" title="Background fill">▧</button>` : '',
          T.levels ? `<button data-act="more" class="${d.more || d.levels ? 'on' : ''}" title="Show extra levels">Ext</button>` : '',
          T.text ? `<button data-act="edit" title="Edit text">✎</button>` : '',
          T.text || T.glyph ? `<select data-act="size" title="${T.glyph ? 'Icon size' : 'Font size'}">${sizes.map((v) => `<option ${v === sv ? 'selected' : ''} value="${v}">${v}</option>`).join('')}</select>` : '',
          T.size ? `<button data-act="bg" class="${d.bg ? 'on' : ''}" title="Background">▣</button>` : '',
          `<button data-act="pop" data-v="tpl" class="${S.pop === 'tpl' ? 'on' : ''}" title="Style templates">Tpl</button>`,
          ...common,
        ];
      }
      toolbar.innerHTML = parts.join('') + popHtml(d, ds);
    }
    const tbSig = () => selSig() + '|' + (S.pop || '') + '|' + selList().reduce((a, d) => a + (d._v || 0), 0);
    function placeToolbar(gs) {
      if (!gs || !S.sel || S.drag || S.editing) { toolbar.classList.add('hidden'); return; }
      const sig = tbSig();
      if (toolbar.dataset.sig !== sig) { buildToolbar(); toolbar.dataset.sig = sig; toolbar.dataset.for = S.sel.id; }
      toolbar.classList.remove('hidden');
      const pts = [];
      for (const g of gs) {
        const hs = g.handles.filter(Boolean);
        pts.push(...(hs.length ? hs : g.box ? [{ x: g.box.bx + g.box.bw / 2, y: g.box.by }, { x: g.box.bx + g.box.bw / 2, y: g.box.by + g.box.bh }] : g.P));
      }
      if (!pts.length) { toolbar.classList.add('hidden'); return; }
      const minY = Math.min(...pts.map((q) => q.y)), cx = pts.reduce((a, q) => a + q.x, 0) / pts.length;
      const { w, h } = host.pane();
      const x = Math.min(Math.max(4, cx - toolbar.offsetWidth / 2), w - toolbar.offsetWidth - 4);
      let y = minY - toolbar.offsetHeight - 14;
      if (y < 4) y = Math.min(h - toolbar.offsetHeight - 4, Math.max(...pts.map((q) => q.y)) + 14);
      y = Math.max(4, y);
      toolbar.style.left = x + 'px'; toolbar.style.top = y + 'px';
      const pop = toolbar.querySelector('.tl-pop');
      if (pop) { const below = y + toolbar.offsetHeight + pop.offsetHeight + 8 <= h || y < h / 2; pop.style.top = below ? 'calc(100% + 4px)' : 'auto'; pop.style.bottom = below ? 'auto' : 'calc(100% + 4px)'; }
    }
    const touch = (d) => { d._v = (d._v || 0) + 1; };
    const redraw = () => { toolbar.dataset.sig = ''; draw(); };
    function cloneMany(ds) {
      const out = ds.map((d) => {
        const c = clone(d); c.id = uid(); delete c._v; delete c.name;
        c.pts = c.pts.map((pt) => ({ t: host.shiftTime(pt.t, 5), p: pt.p })).map((pt, i) => (Number.isFinite(pt.t) ? pt : d.pts[i]));
        if (c.fx != null) { c.fx = Math.min(0.95, c.fx + 0.02); c.fy = Math.min(0.95, c.fy + 0.03); }
        return c;
      });
      cur().push(...out); setMany(out);
    }
    function setVis(ds, u, fn) {
      for (const d of ds) {
        const v = Object.assign({}, d.visibility || {});
        fn(v, VIS_UNITS.find((x) => x.k === u));
        for (const x of VIS_UNITS) if (v[x.k] === true || (Array.isArray(v[x.k]) && v[x.k][0] === x.r[0] && v[x.k][1] === x.r[1])) delete v[x.k];
        if (Object.keys(v).length) d.visibility = v; else delete d.visibility;
        touch(d);
      }
    }
    toolbar.addEventListener('mousedown', (e) => e.stopPropagation());
    toolbar.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && e.target.dataset.role === 'tpl-name') { e.preventDefault(); const b = toolbar.querySelector('[data-act="tpl-save"]'); b && b.click(); }
    });
    toolbar.addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]'), d = S.sel, ds = selList();
      if (!b || !d || b.tagName === 'SELECT' || b.tagName === 'INPUT') return;
      const act = b.dataset.act, v = b.dataset.v, tool = toolKey(d);
      if (act === 'del') return removeMany(ds);
      if (act === 'edit') { editText(d); return; }
      if (act === 'pop') { S.pop = S.pop === v ? null : v; return redraw(); }
      if (act === 'tpl-save') {
        const inp = toolbar.querySelector('[data-role="tpl-name"]'), name = inp && inp.value.trim();
        if (!name) { if (inp) inp.focus(); return; }
        tplEdit(tool, (t) => { t.list[name] = styleOf(d); }); return redraw();
      }
      if (act === 'tpl-def') { tplEdit(tool, (t) => { t.def = t.def === v ? null : v; }); return redraw(); }
      if (act === 'tpl-del') { tplEdit(tool, (t) => { delete t.list[v]; if (t.def === v) t.def = null; }); return redraw(); }
      snapshot();
      if (act === 'tpl-apply') { const st = tplOf(tool).list[v]; if (st) applyStyle(d, st); }
      if (act === 'tpl-reset') applyStyle(d, tplDefault(tool));
      if (act === 'vis-reset') for (const x of ds) { delete x.visibility; touch(x); }
      if (act === 'color') for (const x of ds) { x.color = v; touch(x); }
      if (act === 'extL') d.extL = !d.extL;
      if (act === 'extR') d.extR = !d.extR;
      if (act === 'stats') d.showStats = !d.showStats;
      if (act === 'bg') d.bg = !d.bg;
      if (act === 'fill') d.fill = d.fill === false;
      if (act === 'lock') { const on = !ds.every((x) => x.locked); for (const x of ds) { x.locked = on; touch(x); } }
      if (act === 'hide') { for (const x of ds) { x.hidden = true; touch(x); } setSel(null); }
      if (act === 'more') { d.more = !(d.more || d.levels); d.levels = null; }
      if (act === 'group') { const g0 = d.group, grouped = !!g0 && ds.every((x) => x.group === g0); groupInto(ds, grouped ? null : g0 && ds.every((x) => !x.group || x.group === g0) ? g0 : nextGroup()); }
      if (act === 'clone') cloneMany(ds);
      touch(d); save();
    });
    toolbar.addEventListener('change', (e) => {
      const d = S.sel, ds = selList(), el2 = e.target, act = el2.dataset.act;
      if (!d || !act) return;
      snapshot();
      if (act === 'width') d.width = Number(el2.value);
      if (act === 'style') d.style = Number(el2.value);
      if (act === 'size') d.size = Number(el2.value);
      if (act === 'vis-on') setVis(ds, el2.dataset.u, (vv, u) => { vv[u.k] = el2.checked ? (u.r ? u.r.slice() : true) : false; });
      if (act === 'vis-min' || act === 'vis-max') {
        setVis(ds, el2.dataset.u, (vv, u) => {
          const r = Array.isArray(vv[u.k]) ? vv[u.k].slice() : u.r.slice(), n = Math.round(Number(el2.value));
          if (!Number.isFinite(n)) return;
          r[act === 'vis-min' ? 0 : 1] = Math.max(u.r[0], Math.min(u.r[1], n));
          if (r[0] > r[1]) r[act === 'vis-min' ? 1 : 0] = r[act === 'vis-min' ? 0 : 1];
          vv[u.k] = r;
        });
      }
      touch(d); save(); redraw();
    });

    // ── text editing ─────────────────────────────────
    function editText(d, isNew) {
      const { w, h } = host.pane(), g = geom(d, w, h); if (!g) return;
      const at0 = g.textAt || { x: g.P[0].x, y: g.P[0].y - (d.size || 14) - 4, size: d.size || 14 };
      S.editing = d;
      const ta = document.createElement('textarea');
      ta.className = 'draw-text-input'; ta.value = d.text || ''; ta.rows = Math.max(1, (d.text || '').split('\n').length);
      ta.style.left = at0.x + 'px'; ta.style.top = at0.y + 'px'; ta.style.color = d.color; ta.style.fontSize = (at0.size || 14) + 'px';
      ta.placeholder = d.type === 'table' ? 'Cells separated by | (Enter to save, Shift+Enter for a new row)' : 'Text… (Enter to save, Shift+Enter for a new line)';
      el.parentElement.appendChild(ta);
      const prev = d.text; d.text = ''; touch(d);
      let done = false;
      const finishEdit = (commit) => {
        if (done) return; done = true;
        const v = ta.value.trim();
        ta.remove(); S.editing = null;
        if (commit && v) { if (!isNew) { d.text = prev; snapshot(); } d.text = v; touch(d); save(); }
        else if (isNew) { const Ls = cur(), i = Ls.indexOf(d); if (i >= 0) Ls.splice(i, 1); setSel(null); save(); }
        else { d.text = prev; touch(d); }
      };
      ta.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); finishEdit(true); }
        if (e.key === 'Escape') finishEdit(false);
      });
      ta.addEventListener('blur', () => finishEdit(true));
      setTimeout(() => ta.focus(), 0);
    }

    // ── tool / pointer handling ──────────────────────
    const need = (T) => (T.n === 'multi' ? Infinity : T.n);
    function setTool(tl) {
      S.tool = tl && TOOLS[tl] ? tl : null; S.draft = null; S.down = null;
      if (S.tool) { S.selBefore = selList(); setSel(null); }
      hint.classList.toggle('hidden', !S.tool);
      if (S.tool) hint.textContent = hintText();
      host.onTool && host.onTool(S.tool);
    }
    function hintText() {
      const T = TOOLS[S.tool];
      if (!T) return '';
      if (T.erase) return 'Eraser: click a drawing to remove it · Esc to exit';
      if (T.n === 0) return `${T.label}: press and drag to draw · Esc to cancel`;
      if (T.n === 1) return `${T.label}: click to place · Esc to cancel`;
      const k = S.draft ? S.draft.pts.length : 0;
      if (T.n === 'multi') return `${T.label}: click to add points · double-click or Enter to finish · Esc to cancel`;
      if (S.tool === 'channel' && k >= 2) return `${T.label}: click to set the channel width · Esc to cancel`;
      return `${T.label}: click ${k ? `point ${Math.min(k + 1, T.n)} of ${T.n}` : 'the start point'}${T.n === 2 ? ' (or drag)' : ''} · Esc to cancel`;
    }
    const evPt = (e) => { const r = el.getBoundingClientRect(), s = e.touches ? e.touches[0] || e.changedTouches[0] : e; return { x: s.clientX - r.left, y: s.clientY - r.top }; };
    const inPane = (p) => { const { w, h } = host.pane(); return p.x >= 0 && p.y >= 0 && p.x < w && p.y < h; };
    const at = (p, e) => { const q = host.fromXY(p.x, p.y); if (!q) return null; return (S.magnet !== !!(e && (e.metaKey || e.ctrlKey))) ? host.snap(q, p) : q; };

    function newDrawing(q) {
      const T = TOOLS[S.tool];
      const d = { id: uid(), tool: S.tool, type: T.type || S.tool, color: T.color, width: T.width || 1.5, style: 0, pts: [{ t: q.t, p: q.p }] };
      if (T.fill) d.fill = true;
      if (T.props) Object.assign(d, JSON.parse(JSON.stringify(T.props)));
      const tpl = tplDefault(S.tool); if (tpl) Object.assign(d, clone(tpl));
      if (S.tool === 'long' || S.tool === 'short') {
        const k = host.risk(q.p);
        d.pts.push({ t: host.shiftTime(q.t, 20), p: q.p });
        d.tp = S.tool === 'long' ? q.p + 2 * k : q.p - 2 * k;
        d.sl = S.tool === 'long' ? q.p - k : q.p + k;
      }
      return d;
    }
    function onCreate(d) {
      if (ANCH[d.type]) { const { w, h } = host.pane(), q = xy(d.pts[0]); if (q) { d.fx = q.x / w; d.fy = q.y / h; } }
      if (d.type === 'barspattern') {
        const [a, b] = d.pts[0].t <= d.pts[1].t ? d.pts : [d.pts[1], d.pts[0]], cs = bars(a.t, b.t);
        if (cs && cs.length) {
          const use = cs.slice(-1000), n = use.length;
          d.bars = use.map((c) => [c.open, c.high, c.low, c.close]);
          d.pts = [{ t: host.shiftTime(a.t, n), p: use[0].open }, { t: host.shiftTime(b.t, n), p: use[n - 1].close }];
        } else d.bars = [];
      }
    }
    function finish(d) {
      onCreate(d);
      snapshot();
      cur().push(d); save();
      S.draft = null; S.down = null; setSel(d);
      if (!S.stay) setTool(null); else hint.textContent = hintText();
      if (toolOf(d).edit) editText(d, true);
    }
    function finishMulti() {
      const d = S.draft; if (!d) return false;
      d.pts.pop();
      const out = [];
      for (const pt of d.pts) { const a = out.length ? xy(out[out.length - 1]) : null, b = xy(pt); if (!a || !b || hyp(a, b) > 4) out.push(pt); }
      d.pts = out;
      if (d.pts.length >= 2) finish(d); else { S.draft = null; hint.textContent = hintText(); }
      return true;
    }

    function onDown(e) {
      if (e.button > 0 || S.editing) return;
      const p = evPt(e);
      if (!inPane(p)) return;
      // the host turns Shift+drag into the measure tool before this handler runs; Shift-click on a drawing is multi-select instead
      if (e.shiftKey && S.tool === 'measure' && !S.draft && hit(p)) { const keep = S.selBefore || []; setTool(null); setMany(keep.filter((d) => cur().includes(d))); }
      if (S.tool) {
        e.stopPropagation(); e.preventDefault();
        const T = TOOLS[S.tool];
        if (T.erase) { const h = hit(p); if (h && !lk(h.d)) removeD(h.d); return; }
        const q = at(p, e); if (!q) return;
        if (T.n === 0) { S.draft = newDrawing(q); S.down = { p, brush: true }; return; }
        if (T.n === 1) return finish(newDrawing(q));
        if (!S.draft) { S.draft = newDrawing(q); S.draft.pts.push({ t: q.t, p: q.p }); S.down = { p }; hint.textContent = hintText(); return; }
        if (T.n === 'multi') { const prev = xy(S.draft.pts[S.draft.pts.length - 2]); if (prev && hyp(prev, p) < 6) { finishMulti(); return; } }
        S.draft.pts[S.draft.pts.length - 1] = { t: q.t, p: q.p };
        if (S.draft.pts.length >= need(T)) return finish(S.draft);
        S.draft.pts.push({ t: q.t, p: q.p }); hint.textContent = hintText();
        return;
      }
      const h = hit(p);
      if (!h) { if (!e.shiftKey) setSel(null); return; }
      e.stopPropagation(); e.preventDefault();
      let collapse = false;
      if (e.shiftKey) { if (!toggleSel(h.d)) return; }
      else if (!isSel(h.d)) setSel(h.d);
      else { S.sel = h.d; collapse = S.set.size > 1; notifySel(); }
      if (lk(h.d)) return;
      const q = host.fromXY(p.x, p.y);
      const movers = h.part === 'body' && S.set.size > 1 ? selList().filter((x) => !lk(x)) : [h.d];
      if (q) S.drag = { d: h.d, part: h.part, l0: q.l, p0: q.p, x0: p.x, y0: p.y, o: clone(h.d), os: new Map(movers.map((x) => [x, clone(x)])), moved: false, collapse };
    }
    function onMove(e) {
      const p = evPt(e);
      if (S.tool && S.draft) {
        const q = at(p, e); if (!q) return;
        if (S.down && S.down.brush) { const last = xy(S.draft.pts[S.draft.pts.length - 1]); if (!last || hyp(last, p) > 3) S.draft.pts.push({ t: q.t, p: q.p }); return; }
        S.draft.pts[S.draft.pts.length - 1] = { t: q.t, p: q.p };
        return;
      }
      if (S.drag) {
        if (e.cancelable) e.preventDefault();
        const Dg = S.drag, d = Dg.d, o = Dg.o;
        if (!cur().includes(d)) { S.drag = null; return; }
        const q = Dg.part === 'body' ? host.fromXY(p.x, p.y) : at(p, e);
        if (!q) return;
        if (!Dg.moved) { if (Math.hypot(p.x - Dg.x0, p.y - Dg.y0) < 2) return; Dg.moved = true; pushHist(JSON.stringify(cur().map((x) => Dg.os.get(x) || (x === d ? o : x)))); }
        if (Dg.part === 'body') {
          const dl = q.l - Dg.l0, dp = q.p - Dg.p0, { w, h } = host.pane();
          for (const [x, ox] of Dg.os) {
            x.pts = ox.pts.map((pt) => ({ t: host.shiftTime(pt.t, dl), p: pt.p + dp }));
            if (ox.tp != null) { x.tp = ox.tp + dp; x.sl = ox.sl + dp; }
            if (ox.fx != null) { x.fx = ox.fx + (p.x - Dg.x0) / w; x.fy = ox.fy + (p.y - Dg.y0) / h; }
            touch(x);
          }
        } else if (Dg.part === 'resize') { const c = xy(d.pts[0]); if (c) d.size = Math.round(Math.max(8, Math.min(240, 2 * Math.max(Math.abs(p.x - c.x), Math.abs(p.y - c.y))))); }
        else if (Dg.part === 'entry') { d.pts[0] = { t: q.t, p: q.p }; d.pts[1] = { t: d.pts[1].t, p: q.p }; }
        else if (Dg.part === 'edge') d.pts[1] = { t: q.t, p: d.pts[0].p };
        else if (Dg.part === 'tp') d.tp = q.p;
        else if (Dg.part === 'sl') d.sl = q.p;
        else if (typeof Dg.part === 'number') d.pts[Dg.part] = { t: q.t, p: q.p };
        touch(d);
        return;
      }
      if (!el.contains(e.target) && e.target !== el) { S.hover = null; return; }
      const h = inPane(p) ? hit(p) : null;
      S.hover = h ? h.d : null;
      el.style.cursor = S.tool ? (TOOLS[S.tool].erase && h ? 'pointer' : 'crosshair') : h ? (h.part === 'body' ? (lk(h.d) ? 'pointer' : 'move') : h.part === 'resize' ? 'nwse-resize' : 'grab') : '';
    }
    function onUp(e) {
      if (S.tool && S.draft && S.down) {
        const p = evPt(e);
        if (S.down.brush) { const d = S.draft; S.down = null; if (d.pts.length > 1) finish(d); else S.draft = null; return; }
        const T = TOOLS[S.tool];
        if (T.n === 2 && hyp(p, S.down.p) > 6) { S.down = null; return finish(S.draft); }
        S.down = null;
        return;
      }
      if (S.drag) { const { moved, collapse, d } = S.drag; S.drag = null; if (moved) save(); else if (collapse) setSel(d); }
    }
    function onDbl(e) {
      if (S.tool && S.draft && TOOLS[S.tool].n === 'multi') { e.stopPropagation(); e.preventDefault(); finishMulti(); return; }
      const p = evPt(e); const h = inPane(p) ? hit(p) : null;
      if (h && toolOf(h.d).text && !lk(h.d)) { e.stopPropagation(); setSel(h.d); editText(h.d); }
    }
    function onKey(e) {
      if (e.key === 'Enter' && S.tool && S.draft && TOOLS[S.tool].n === 'multi' && !S.editing) { e.preventDefault(); finishMulti(); }
    }
    el.addEventListener('mousedown', onDown, true);
    el.addEventListener('touchstart', onDown, { capture: true, passive: false });
    el.addEventListener('dblclick', onDbl, true);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('touchmove', onMove, { passive: false });
    window.addEventListener('mouseup', onUp);
    window.addEventListener('touchend', onUp);
    window.addEventListener('keydown', onKey);

    function removeD(d) {
      const Ls = cur(), i = Ls.indexOf(d);
      if (i < 0) return false;
      snapshot();
      Ls.splice(i, 1);
      if (isSel(d)) setMany(selList().filter((x) => x !== d));
      S.hover = null; save();
      return true;
    }
    function removeMany(ds) {
      const Ls = cur(), gone = ds.filter((d) => Ls.includes(d) && !lk(d));
      if (!gone.length) return 0;
      snapshot();
      for (const d of gone) Ls.splice(Ls.indexOf(d), 1);
      setMany(selList().filter((x) => !gone.includes(x))); S.hover = null; save();
      return gone.length;
    }
    const many = (ids) => (Array.isArray(ids) ? ids : [ids]).map(byId).filter(Boolean);
    const mutateMany = (ids, fn) => { const ds = many(ids); if (!ds.length) return false; snapshot(); fn(ds); ds.forEach(touch); save(); return true; };
    function rectSel(x0, y0, x1, y1) {
      const a = Math.min(x0, x1), b = Math.max(x0, x1), c = Math.min(y0, y1), e = Math.max(y0, y1), { w, h } = host.pane();
      ivNow();
      return cur().filter((d) => { if (!shown(d)) return false; const g = S.gc.get(d) || geom(d, w, h); return g && g.bb[0] <= b && g.bb[2] >= a && g.bb[1] <= e && g.bb[3] >= c; });
    }
    function undoRedo(from, to) {
      const k = key(); if (!k) return false;
      const st = (H[from][k] = H[from][k] || []);
      if (!st.length) return false;
      (H[to][k] = H[to][k] || []).push(JSON.stringify(cur()));
      const Ls = cur(); Ls.splice(0, Ls.length, ...JSON.parse(st.pop()));
      setSel(null); S.hover = null; save();
      return true;
    }
    const mutate = (id, fn) => { const d = byId(id); if (!d) return false; snapshot(); fn(d); touch(d); save(); return true; };
    const valid = (d) => d && typeof d === 'object' && typeof d.type === 'string' && Array.isArray(d.pts) && d.pts.every((q) => q && Number.isFinite(q.t) && Number.isFinite(q.p));

    return {
      TOOLS, GROUPS, draw, setTool,
      get tool() { return S.tool; },
      get selected() { return S.sel; },
      get selection() { return selList(); },
      get count() { return cur().length; },
      list: () => { ivNow(); return cur().map(info); },
      select(id) {
        if (Array.isArray(id)) { const ds = many(id); setMany(ds); return ds.length === id.length; }
        const d = id == null ? null : byId(id); if (id != null && !d) return false; setSel(d); return true;
      },
      selectedIds: () => selList().map((d) => d.id),
      selectAll() { ivNow(); setMany(cur().filter(shown)); return S.set.size; },
      selectInRect(x0, y0, x1, y1, { add = false } = {}) { const ds = rectSel(x0, y0, x1, y1); setMany(add ? [...new Set(selList().concat(ds))] : ds); return ds.length; },
      hitAt(e) { const p = e && e.clientX != null ? evPt(e) : e; return !!(p && inPane(p) && hit(p)); },
      // clipboard is shared by every engine on the page; pasting into the same market offsets each paste by 5 bars
      copy() { const ds = selList(); if (!ds.length) return 0; CLIP = { key: key(), n: 0, items: JSON.parse(JSON.stringify(ds, (k, v) => (k === '_v' ? undefined : v))) }; return ds.length; },
      paste() {
        if (!CLIP || !key()) return 0;
        const same = CLIP.key === key(), k = same ? 5 * ++CLIP.n : 0, { w, h } = host.pane();
        const out = clone(CLIP.items).map((c) => {
          c.id = uid(); delete c.group; delete c.gHidden; delete c.gLocked; delete c.hidden; delete c.locked;
          if (k) c.pts = c.pts.map((pt) => { const t2 = host.shiftTime(pt.t, k); return { t: Number.isFinite(t2) ? t2 : pt.t, p: pt.p }; });
          if (k && c.fx != null) { c.fx = Math.min(0.95, c.fx + (0.02 * k) / 5); c.fy = Math.min(0.95, c.fy + (0.03 * k) / 5); }
          return c;
        }).filter(valid);
        if (!out.length) return 0;
        snapshot(); cur().push(...out); setMany(out); S.hover = null; save();
        return out.length;
      },
      canPaste: () => !!CLIP,
      setVisibility: (ids, vis) => mutateMany(ids, (ds) => ds.forEach((d) => { if (vis && typeof vis === 'object' && Object.keys(vis).length) d.visibility = clone(vis); else delete d.visibility; })),
      isVisibleNow: (id) => { const d = byId(id); ivNow(); return !!d && shown(d); },
      groups() {
        const m = new Map();
        for (const d of cur()) if (d.group) { const g = m.get(d.group) || { name: d.group, ids: [], hidden: true, locked: true }; g.ids.push(d.id); g.hidden = g.hidden && !!d.gHidden; g.locked = g.locked && !!d.gLocked; m.set(d.group, g); }
        return [...m.values()];
      },
      setGroup(ids, name) { const nm = name == null ? null : String(name).trim() || null; return mutateMany(ids, (ds) => groupInto(ds, nm)); },
      groupSelected(name) { const ds = selList(); if (!ds.length) return null; const nm = (name && String(name).trim()) || nextGroup(); snapshot(); groupInto(ds, nm); save(); return nm; },
      ungroupSelected() { const ds = selList().filter((d) => d.group); if (!ds.length) return false; snapshot(); groupInto(ds, null); save(); return true; },
      selectGroup(name) { const ds = members(name); setMany(ds); return ds.length; },
      setGroupHidden(name, v) { const ds = members(name); if (!ds.length) return false; snapshot(); for (const d of ds) { if (v) d.gHidden = true; else delete d.gHidden; touch(d); } if (v) setMany(selList().filter((d) => !ds.includes(d))); save(); return true; },
      setGroupLocked(name, v) { const ds = members(name); if (!ds.length) return false; snapshot(); for (const d of ds) { if (v) d.gLocked = true; else delete d.gLocked; touch(d); } save(); return true; },
      renameGroup(a, b) { const ds = members(a), nb = b == null ? '' : String(b).trim(); if (!ds.length || !nb) return false; snapshot(); for (const d of ds) { d.group = nb; touch(d); } save(); return true; },
      removeGroup(name, { drawings = false } = {}) { const ds = members(name); if (!ds.length) return 0; if (drawings) return removeMany(ds); snapshot(); groupInto(ds, null); save(); return ds.length; },
      templates(tool) { const e = tplOf(tool); return Object.keys(e.list).map((name) => ({ name, isDefault: e.def === name, style: clone(e.list[name]) })); },
      saveTemplate(id, name) { const d = byId(id), nm = name && String(name).trim(); if (!d || !nm) return false; tplEdit(toolKey(d), (t) => { t.list[nm] = styleOf(d); }); redraw(); return true; },
      applyTemplate: (id, name) => { const d = byId(id); const st = d && tplOf(toolKey(d)).list[name]; return st ? mutate(d, (x) => applyStyle(x, st)) : false; },
      applyDefault: (id) => mutate(id, (x) => applyStyle(x, tplDefault(toolKey(x)))),
      deleteTemplate(tool, name) { if (!tplOf(tool).list[name]) return false; tplEdit(tool, (t) => { delete t.list[name]; if (t.def === name) t.def = null; }); redraw(); return true; },
      setDefaultTemplate(tool, name) { if (name != null && !tplOf(tool).list[name]) return false; tplEdit(tool, (t) => { t.def = name == null ? null : name; }); redraw(); return true; },
      remove(id) { const d = byId(id); return d ? removeD(d) : false; },
      setItemHidden: (id, v) => mutate(id, (d) => { d.hidden = !!v; if (v && isSel(d)) setMany(selList().filter((x) => x !== d)); }),
      setItemLocked: (id, v) => mutate(id, (d) => { d.locked = !!v; }),
      rename: (id, name) => mutate(id, (d) => { if (name && String(name).trim()) d.name = String(name).trim(); else delete d.name; }),
      exportAll: () => JSON.parse(JSON.stringify(S.all, (k, v) => (k === '_v' ? undefined : v))),
      importAll(obj, { merge = false } = {}) {
        if (!obj || typeof obj !== 'object') return 0;
        let n = 0;
        if (!merge) for (const k of Object.keys(S.all)) delete S.all[k];
        for (const [k, arr] of Object.entries(obj)) {
          if (!Array.isArray(arr)) continue;
          const good = JSON.parse(JSON.stringify(arr.filter(valid))).map((d) => ({ ...d, id: d.id || uid() }));
          if (!good.length) continue;
          S.all[k] = merge && S.all[k] ? S.all[k].concat(good) : good; n += good.length;
          H.undo[k] = []; H.redo[k] = [];
        }
        setSel(null); S.hover = null; S.draft = null; save();
        return n;
      },
      finishDraft: () => (S.draft && TOOLS[S.tool] && TOOLS[S.tool].n === 'multi' ? finishMulti() : false),
      cancel() { if (S.editing) return true; if (S.pop) { S.pop = null; redraw(); return true; } if (S.tool) { setTool(null); return true; } if (S.sel) { setSel(null); return true; } return false; },
      deleteSelected: () => removeMany(selList()) > 0,
      undo: () => undoRedo('undo', 'redo'),
      redo: () => undoRedo('redo', 'undo'),
      clear() { const Ls = cur(); if (!Ls.length) return; snapshot(); Ls.splice(0, Ls.length); setSel(null); save(); },
      reset() { S.hover = S.drag = S.draft = null; setSel(null); setTool(null); },
      setMagnet(v) { S.magnet = v; }, get magnet() { return S.magnet; },
      setLockAll(v) { S.lockAll = v; }, get lockAll() { return S.lockAll; },
      setHidden(v) { S.hidden = v; if (v) setSel(null); }, get hidden() { return S.hidden; },
      setStay(v) { S.stay = v; }, get stay() { return S.stay; },
      isBusy: () => !!(S.tool || S.drag || S.editing),
      destroy() {
        el.removeEventListener('mousedown', onDown, true); el.removeEventListener('touchstart', onDown, true); el.removeEventListener('dblclick', onDbl, true);
        window.removeEventListener('mousemove', onMove); window.removeEventListener('touchmove', onMove); window.removeEventListener('mouseup', onUp);
        window.removeEventListener('touchend', onUp); window.removeEventListener('keydown', onKey);
      },
    };
  }

  window.IGDraw = { create, TOOLS, COLORS, GROUPS, alertGeometry, priceAt, visibleOn, VIS_UNITS };
})();
