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
    count: 85,
    venue: "Transit Station",
    img: "https://images.unsplash.com/photo-1549887534-4e1a03c9f537?w=400",
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
    img: "https://images.unsplash.com/photo-1590608897129-79da98d159c8?w=400",
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
    img: "https://images.unsplash.com/photo-1534438327276-14e5300c3a48?w=400",
  },
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
    venue: "Transit Station",
    img: "https://images.unsplash.com/photo-1523875194681-bedd468c58bf?w=400",
  },
  {
    name: "Philadelphia",
    coords: [-75.1652, 39.9526],
    count: 85,
    venue: "Pharmacy",
    img: "https://images.unsplash.com/photo-1586099840923-42d64ef2c4f3?w=400",
  },
  {
    name: "Minneapolis",
    coords: [-93.2650, 44.9778],
    count: 50,
    venue: "Retail Store",
    img: "https://images.unsplash.com/photo-1568605114967-8130f3a36994?w=400",
  },
  {
    name: "Detroit",
    coords: [-83.0458, 42.3314],
    count: 45,
    venue: "Gas Station",
    img: "https://images.unsplash.com/photo-1601924582971-c9a7e61c29f8?w=400",
  },
  {
    name: "Charlotte",
    coords: [-80.8431, 35.2271],
    count: 55,
    venue: "Billboard",
    img: "https://images.unsplash.com/photo-1510626176961-4b37d0dd0d3a?w=400",
  },
];

// For quick search / map fly-to lookups
const CITY_CENTERS = Object.fromEntries(
  CLUSTER_CITIES.map((c) => [c.name.toLowerCase(), c.coords])
);
