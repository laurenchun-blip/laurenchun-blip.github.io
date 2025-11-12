// signs-data.js
// Billboard / sign locations for zoomed-in map

const SIGN_DATA = [
  // --- New York ---
  { city: "New York", title: "Times Square Billboard", venue: "entertainment", coords: [40.758, -73.9855], img: "https://images.unsplash.com/photo-1504274066651-8d31a536b11a?w=400", href: "#" },
  { city: "New York", title: "Brooklyn Retail Plaza", venue: "retail", coords: [40.6782, -73.9442], img: "https://images.unsplash.com/photo-1521737604893-d14cc237f11d?w=400", href: "#" },
  { city: "New York", title: "Brooklyn Retail Plaza", venue: "retail", coords: [40.7225805,-73.992504], img: "https://images.unsplash.com/photo-1521737604893-d14cc237f11d?w=400", href: "#" },
  { city: "New York", title: "Brooklyn Retail Plaza", venue: "retail", coords: [40.7275261,-73.9427065], img: "https://images.unsplash.com/photo-1521737604893-d14cc237f11d?w=400", href: "#" },
  { city: "Jersey City", title: "Downtown Retail Billboard", venue: "retail", coords: [40.7177394,-74.0393715], img: "https://images.unsplash.com/photo-1521737604893-d14cc237f11d?w=400", href: "#" },
  { city: "Hoboken", title: "Hudson Financial Center", venue: "financial", coords: [40.743, -74.032], img: "https://images.unsplash.com/photo-1561414927-6d86591d0c4b?w=400", href: "#" },

  // --- Los Angeles ---
  { city: "Los Angeles", title: "Hollywood Boulevard Billboard", venue: "entertainment", coords: [34.1016, -118.3269], img: "https://images.unsplash.com/photo-1503602642458-232111445657?w=400", href: "#" },
  { city: "Los Angeles", title: "Santa Monica Promenade Retail", venue: "retail", coords: [34.017, -118.496], img: "https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?w=400", href: "#" },

  // --- Chicago ---
  { city: "Chicago", title: "Magnificent Mile Display", venue: "retail", coords: [41.8947, -87.6243], img: "https://images.unsplash.com/photo-1556740749-887f6717d7e4?w=400", href: "#" },
  { city: "Chicago", title: "O'Hare Terminal Transit Ad", venue: "transit", coords: [41.9742, -87.9073], img: "https://images.unsplash.com/photo-1590608897129-79da98d159c8?w=400", href: "#" },

  // --- South Bend ---
  { city: "South Bend", title: "Zoo Urban Panel", venue: "entertainment", coords: [41.6764104, -86.2911189], img: "https://blipboards-bb-storage.s3.amazonaws.com/lambda-images/sign-photos/resized/SignPhoto-4xdhkx-resized.jpg", href: "#" },
  { city: "South Bend", title: "University District Ad", venue: "health", coords: [41.6923685,-86.2925644], img: "https://blipboards-bb-storage.s3.amazonaws.com/lambda-images/sign-photos/resized/SignPhoto-4xdhkx-resized.jpg", href: "#" },

  // --- Dallas ---
  { city: "Dallas", title: "Downtown Billboard", venue: "retail", coords: [32.7767, -96.797], img: "https://images.unsplash.com/photo-1596394516091-946b8f0e20e0?w=400", href: "#" },
  { city: "Dallas", title: "Frisco Mall Screen", venue: "retail", coords: [33.1507, -96.8236], img: "https://images.unsplash.com/photo-1561715276-a2d6cc95c0fb?w=400", href: "#" },

  // --- Atlanta ---
  { city: "Atlanta", title: "Peachtree Center Billboard", venue: "financial", coords: [33.757, -84.387], img: "https://images.unsplash.com/photo-1505843513577-22bb7d21e455?w=400", href: "#" },
  { city: "Atlanta", title: "Midtown Retail Display", venue: "retail", coords: [33.792, -84.385], img: "https://images.unsplash.com/photo-1525610553991-2bede1a236e2?w=400", href: "#" },

  // --- Miami ---
  { city: "Miami", title: "Downtown Mall Board", venue: "retail", coords: [25.774, -80.193], img: "https://images.unsplash.com/photo-1521737604893-d14cc237f11d?w=400", href: "#" },
  { city: "Miami", title: "South Beach Entertainment Display", venue: "entertainment", coords: [25.7906, -80.130], img: "https://images.unsplash.com/photo-1510626176961-4b37d0dd0d3a?w=400", href: "#" },

  // --- Denver ---
  { city: "Denver", title: "Union Station Transit Screen", venue: "transit", coords: [39.7525, -104.999], img: "https://images.unsplash.com/photo-1605296867304-46d5465a13f1?w=400", href: "#" },
  { city: "Denver", title: "Cherry Creek Retail Ad", venue: "retail", coords: [39.718, -104.952], img: "https://images.unsplash.com/photo-1565538810643-1c1e08b34e5f?w=400", href: "#" },

  // --- Salt Lake City ---
  { city: "Salt Lake City", title: "City Creek Center Billboard", venue: "retail", coords: [40.768, -111.892], img: "https://blipboards-bb-storage.s3.amazonaws.com/lambda-images/sign-photos/resized/SignPhoto-4xdhkx-resized.jpg", href: "#" },
  { city: "Salt Lake City", title: "University District Ad", venue: "health", coords: [40.760, -111.847], img: "https://blipboards-bb-storage.s3.amazonaws.com/lambda-images/sign-photos/resized/SignPhoto-4xdhkx-resized.jpg", href: "#" },

  // --- Seattle ---
  { city: "Seattle", title: "Downtown Transit Billboard", venue: "transit", coords: [47.6062, -122.3321], img: "https://images.unsplash.com/photo-1504754524776-8f4f37790ca0?w=400", href: "#" },
  { city: "Seattle", title: "Ballard Brewery Display", venue: "entertainment", coords: [47.6687, -122.3846], img: "https://images.unsplash.com/photo-1556767576-5ec41a8f7e2d?w=400", href: "#" }
];
