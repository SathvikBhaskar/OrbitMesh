fetch("https://celestrak.org/NORAD/elements/gp.php?GROUP=weather&FORMAT=tle")
  .then(res => res.text())
  .then(data => console.log(data.split('\n').slice(0, 6).join('\n')))
  .catch(err => console.error(err));
