fetch("https://celestrak.org/NORAD/elements/gp.php?GROUP=weather&FORMAT=json")
  .then(res => res.json())
  .then(data => console.log(JSON.stringify(data.slice(0, 2), null, 2)))
  .catch(err => console.error(err));
