// cluster-cities.js
// City clusters with metadata for homepage map

const CLUSTER_CITIES = [
  {
    name: "New York",
    coords: [-74.006, 40.7128],
    count: 200,
    venue: "Pharmacy",
    img: "assets/NY-12345.jpg",
  },
  {
    name: "Los Angeles",
    coords: [-118.2437, 34.0522],
    count: 180,
    venue: "Billboard",
    img: "https://images.unsplash.com/photo-1503602642458-232111445657?w=400",
  },
  {
    name: "Chicago",
    coords: [-87.6298, 41.8781],
    count: 120,
    venue: "Gas Station",
    img: "https://images.unsplash.com/photo-1603791452906-cda9f8efc9b4?w=400",
  },
  {
    name: "Dallas",
    coords: [-96.797, 32.7767],
    count: 95,
    venue: "Retail Store",
    img: "https://images.unsplash.com/photo-1561715276-a2d6cc95c0fb?w=400",
  },
  {
    name: "Atlanta",
    coords: [-84.388, 33.749],
    count: 80,
    venue: "Billboard",
    img: "https://images.unsplash.com/photo-1505843513577-22bb7d21e455?w=400",
  },
  {
    name: "Miami",
    coords: [-80.1918, 25.7617],
    count: 70,
    venue: "Restaurant",
    img: "https://images.unsplash.com/photo-1525610553991-2bede1a236e2?w=400",
  },
  { name: "Nashville", coords: [-86.7816, 36.1627], count: 60, venue: "Entertainment", img: "https://picsum.photos/seed/nashville/400/200" },
  { name: "New Orleans", coords: [-90.0715, 29.9511], count: 50, venue: "Entertainment", img: "https://picsum.photos/seed/neworleans/400/200" },
{ name: "San Antonio", coords: [-98.4936, 29.4241], count: 80, venue: "Retail", img: "https://picsum.photos/seed/sanantonio/400/200" },
  { name: "Austin", coords: [-97.7431, 30.2672], count: 90, venue: "Entertainment", img: "https://picsum.photos/seed/austin/400/200" },

  {
    name: "Houston",
    coords: [-95.3698, 29.7604],
    count: 75,
    venue: "Convenience Store",
    img: "https://images.unsplash.com/photo-1585392960139-85528b3faec0?w=400",
  },
  {
    name: "San Francisco",
    coords: [-122.4194, 37.7749],
    count: 71,
    venue: "Transit Station",
    img: "https://blipboards-bb-storage.s3.amazonaws.com/lambda-images/sign-photos/resized/SignPhoto-7xx2va-resized.jpg",
  },
  {
    name: "Denver",
    coords: [-104.9903, 39.7392],
    count: 60,
    venue: "Gym",
    img: "https://images.unsplash.com/photo-1605296867304-46d5465a13f1?w=400",
  },
  {
    name: "Salt Lake City",
    coords: [-111.8910, 40.7608],
    count: 55,
    venue: "Billboard",
    img: "assets/UT-02830.jpg",
  },
  {
    name: "Seattle",
    coords: [-122.3321, 47.6062],
    count: 65,
    venue: "Coffee Shop",
    img: "https://images.unsplash.com/photo-1504754524776-8f4f37790ca0?w=400",
  },
  {
    name: "Phoenix",
    coords: [-112.074, 33.4484],
    count: 50,
    venue: "Billboard",
    img: "https://blipboards-bb-storage.s3.amazonaws.com/lambda-images/sign-photos/resized/SignPhoto-5bsvan-resized.jpg",
  },
  {
    name: "Orlando",
    coords: [-81.379, 28.5383],
    count: 45,
    venue: "Airport Sign",
    img: "https://images.unsplash.com/photo-1565538810643-1c1e08b34e5f?w=400",
  },
  {
    name: "Las Vegas",
    coords: [-115.1398, 36.1699],
    count: 40,
    venue: "Casino Display",
    img: "https://blipboards-bb-storage.s3.amazonaws.com/lambda-images/sign-photos/resized/SignPhoto-u5e7q3-resized.jpg",
  },
   { name: "Detroit", coords: [-83.0458, 42.3314], count: 65, venue: "Retail", img: "https://picsum.photos/seed/detroit/400/200" },
  { name: "Minneapolis", coords: [-93.265, 44.9778], count: 55, venue: "Retail", img: "https://picsum.photos/seed/minneapolis/400/200" },
  { name: "Indianapolis", coords: [-86.1581, 39.7684], count: 45, venue: "Convenience Store", img: "https://picsum.photos/seed/indianapolis/400/200" },
  { name: "Kansas City", coords: [-94.5786, 39.0997], count: 40, venue: "Grocery Store", img: "https://picsum.photos/seed/kansascity/400/200" },

  {
    name: "Portland",
    coords: [-122.6765, 45.5231],
    count: 35,
    venue: "Grocery Store",
    img: "https://images.unsplash.com/photo-1556767576-5ec41a8f7e2d?w=400",
  },
  {
    name: "Boston",
    coords: [-71.0589, 42.3601],
    count: 90,
    venue: "Billboard",
    img: "https://blipboards-bb-storage.s3.amazonaws.com/lambda-images/sign-photos/resized/SignPhoto-52yu2c-resized.jpg",
  },
  {
    name: "Philadelphia",
    coords: [-75.1652, 39.9526],
    count: 85,
    venue: "Pharmacy",
    img: "https://blipboards-bb-storage.s3.amazonaws.com/lambda-images/sign-photos/resized/SignPhoto-9bh4n8-resized.jpg",
  },
  {
    name: "Charlotte",
    coords: [-80.8431, 35.2271],
    count: 55,
    venue: "Billboard",
    img: "https://images.unsplash.com/photo-1510626176961-4b37d0dd0d3a?w=400",
  },

    { name: "Birmingham", coords: [-86.8025, 33.5186], count: 40, venue: "Retail", img: "https://picsum.photos/seed/birmingham/400/200" }, // Alabama
  { name: "Little Rock", coords: [-92.2896, 34.7465], count: 35, venue: "Retail", img: "https://picsum.photos/seed/littlerock/400/200" }, // Arkansas
  { name: "Tucson", coords: [-110.9747, 32.2226], count: 40, venue: "Transit", img: "https://picsum.photos/seed/tucson/400/200" }, // Arizona secondary
  { name: "Fresno", coords: [-119.7871, 36.7378], count: 45, venue: "Retail", img: "https://picsum.photos/seed/fresno/400/200" }, // California secondary
  { name: "Colorado Springs", coords: [-104.8214, 38.8339], count: 30, venue: "Transit", img: "https://picsum.photos/seed/coloradosprings/400/200" }, // Colorado secondary
  { name: "Hartford", coords: [-72.6851, 41.7637], count: 30, venue: "Financial", img: "https://picsum.photos/seed/hartford/400/200" }, // Connecticut
  { name: "Wilmington", coords: [-75.5467, 39.7447], count: 25, venue: "Retail", img: "https://picsum.photos/seed/wilmington/400/200" }, // Delaware
  { name: "Boise", coords: [-116.2023, 43.615], count: 35, venue: "Retail", img: "https://picsum.photos/seed/boise/400/200" }, // Idaho
  { name: "Louisville", coords: [-85.7585, 38.2527], count: 50, venue: "Retail", img: "https://picsum.photos/seed/louisville/400/200" }, // Kentucky
 
  { name: "Baltimore", coords: [-76.6122, 39.2904], count: 60, venue: "Retail", img: "https://picsum.photos/seed/baltimore/400/200" }, // Maryland
  { name: "St. Louis", coords: [-90.1994, 38.627], count: 70, venue: "Retail", img: "https://picsum.photos/seed/stlouis/400/200" }, // Missouri
  { name: "Jackson", coords: [-90.1848, 32.2988], count: 25, venue: "Retail", img: "https://picsum.photos/seed/jackson/400/200" }, // Mississippi
  { name: "Omaha", coords: [-95.998, 41.2524], count: 35, venue: "Retail", img: "https://picsum.photos/seed/omaha/400/200" }, // Nebraska
  { name: "Manchester", coords: [-71.4548, 42.9956], count: 25, venue: "Retail", img: "https://picsum.photos/seed/manchester/400/200" }, // New Hampshire
  { name: "Albuquerque", coords: [-106.6504, 35.0844], count: 40, venue: "Transit", img: "https://picsum.photos/seed/albuquerque/400/200" }, // New Mexico
  { name: "Raleigh", coords: [-78.6382, 35.7796], count: 50, venue: "Health", img: "https://picsum.photos/seed/raleigh/400/200" }, // North Carolina
  { name: "Fargo", coords: [-96.7898, 46.8772], count: 15, venue: "Retail", img: "https://picsum.photos/seed/fargo/400/200" }, // North Dakota
  { name: "Columbus", coords: [-82.9988, 39.9612], count: 65, venue: "Retail", img: "https://picsum.photos/seed/columbus/400/200" }, // Ohio
  { name: "Oklahoma City", coords: [-97.5164, 35.4676], count: 60, venue: "Retail", img: "https://picsum.photos/seed/okc/400/200" }, // Oklahoma
  { name: "Pittsburgh", coords: [-79.9959, 40.4406], count: 60, venue: "Retail", img: "https://picsum.photos/seed/pittsburgh/400/200" }, // Pennsylvania
  { name: "Charleston", coords: [-81.6326, 38.3498], count: 20, venue: "Retail", img: "https://picsum.photos/seed/charleston/400/200" }, // West Virginia
  { name: "Memphis", coords: [-90.049, 35.1495], count: 55, venue: "Retail", img: "https://picsum.photos/seed/memphis/400/200" }, // Tennessee secondary
  { name: "Charleston", coords: [-79.9311, 32.7765], count: 30, venue: "Retail", img: "https://picsum.photos/seed/charlestonSC/400/200" }, // South Carolina
  { name: "Sioux Falls", coords: [-96.7311, 43.5446], count: 15, venue: "Retail", img: "https://picsum.photos/seed/siouxfalls/400/200" }, // South Dakota
  { name: "Knoxville", coords: [-83.9207, 35.9606], count: 30, venue: "Retail", img: "https://picsum.photos/seed/knoxville/400/200" }, // Tennessee secondary
  { name: "El Paso", coords: [-106.485, 31.7619], count: 40, venue: "Retail", img: "https://picsum.photos/seed/elpaso/400/200" }, // Texas secondary
  { name: "Richmond", coords: [-77.436, 37.5407], count: 45, venue: "Retail", img: "https://picsum.photos/seed/richmond/400/200" }, // Virginia
  { name: "Milwaukee", coords: [-87.9065, 43.0389], count: 55, venue: "Retail", img: "https://picsum.photos/seed/milwaukee/400/200" }, // Wisconsin
  { name: "Cheyenne", coords: [-104.8202, 41.1399], count: 10, venue: "Retail", img: "https://picsum.photos/seed/cheyenne/400/200" }, // Wyoming
  {
  name: "Billings",
  coords: [-108.5007, 45.7833],
  count: 28,
  venue: "Retail",
  img: "https://picsum.photos/seed/billings/400/200",
  // aliases: ["Bozeman", "Missoula", "Great Falls"]
},
];

// For quick search / map fly-to lookups
const CITY_CENTERS = Object.fromEntries(
  CLUSTER_CITIES.map((c) => [c.name.toLowerCase(), c.coords])
);
